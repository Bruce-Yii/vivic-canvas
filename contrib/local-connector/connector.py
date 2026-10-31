#!/usr/bin/env python3
"""Small, localhost-only process connector for a user-owned decision service.

The connector deliberately owns only the child process it starts.  It exposes a
small JSON/HTTP protocol for the web application; model credentials and model
files stay on the local machine and are never forwarded to a browser.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse


PROTOCOL_VERSION = "0.1"
DEFAULT_PORT = 8791
MAX_BODY_BYTES = 64 * 1024


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def error_body(code: str, message: str, *, retryable: bool = False, **details: Any) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "retryable": retryable, **details}}


@dataclass
class Run:
    run_id: str
    text: str
    status: str = "queued"
    result: Optional[dict[str, Any]] = None
    error: Optional[dict[str, Any]] = None
    created_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    submitted_at: float = field(default_factory=time.monotonic)

    def as_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "runId": self.run_id,
            "status": self.status,
            "createdAt": self.created_at,
        }
        if self.result is not None:
            value["result"] = self.result
        if self.error is not None:
            value["error"] = self.error
        if self.finished_at is not None:
            value["finishedAt"] = self.finished_at
        return value


@dataclass
class Download:
    task_id: str
    model_id: str
    total: int
    path: Path
    status: str = "queued"
    completed: int = 0
    error: Optional[str] = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    worker: Optional[threading.Thread] = None

    def as_dict(self, root: Path) -> dict[str, Any]:
        try:
            display_path = self.path.relative_to(root).as_posix()
        except ValueError:
            display_path = self.path.name
        return {
            "taskId": self.task_id,
            "modelId": self.model_id,
            "status": self.status,
            "bytesTotal": self.total,
            "bytesDownloaded": self.completed,
            "displayPath": display_path,
            **({"error": self.error} if self.error else {}),
        }


class ConnectorState:
    """In-memory session state.  A new connector process gets a new owner."""

    def __init__(
        self,
        data_dir: Path,
        provider_command: Optional[list[str]] = None,
        provider_port: Optional[int] = None,
        model_source_dir: Optional[Path] = None,
        model_catalog: Optional[list[dict[str, Any]]] = None,
        write_timeout: float = 2.0,
        startup_timeout: float = 15.0,
        inference_timeout: float = 30.0,
    ) -> None:
        self.lock = threading.RLock()
        self.closed = False
        # Serialize lifecycle changes, but never hold the state lock during I/O.
        self.lifecycle_lock = threading.RLock()
        self.write_timeout = write_timeout
        self.startup_timeout = startup_timeout
        self.inference_timeout = inference_timeout
        if any(not 0 < value < float("inf") for value in (write_timeout, startup_timeout, inference_timeout)):
            raise ValueError("timeouts must be positive finite seconds")
        self.outgoing: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=16)
        self.write_started: Optional[float] = None
        self.start_deadline: Optional[float] = None
        self.data_dir = data_dir.resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.model_source_dir = (model_source_dir or self.data_dir / "sources").resolve()
        self.provider_command = provider_command or [sys.executable, str(Path(__file__).resolve().with_name("mock_provider.py"))]
        self.provider_port = provider_port
        self.session_id = uuid.uuid4().hex
        self.token = secrets.token_urlsafe(32)
        self.process: Optional[subprocess.Popen[str]] = None
        self.reader_thread: Optional[threading.Thread] = None
        self.monitor_thread: Optional[threading.Thread] = None
        self.provider_state = "offline"
        self.provider_error: Optional[dict[str, Any]] = None
        self.started_at: Optional[float] = None
        self.runs: dict[str, Run] = {}
        self.downloads: dict[str, Download] = {}
        self.model_catalog = model_catalog or [
            {
                "id": "mock-decision",
                "label": "Built-in decision protocol fixture",
                "sizeBytes": 0,
                "source": None,
                "path": "models/mock-decision",
            }
        ]

    def _provider_env(self) -> dict[str, str]:
        # Do not pass the caller's environment wholesale.  In particular this
        # prevents API keys and OAuth tokens from reaching a child by accident.
        allowed = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"}
        env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
        env["PYTHONIOENCODING"] = "utf-8"
        if self.provider_port is not None:
            env["VIVIC_PROVIDER_PORT"] = str(self.provider_port)
        return env

    def _port_is_free(self) -> bool:
        if self.provider_port is None:
            return True
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.15)
            return sock.connect_ex(("127.0.0.1", self.provider_port)) != 0

    def _set_provider_error(self, code: str, message: str, *, retryable: bool = True) -> None:
        self.provider_state = "error"
        self.provider_error = {"code": code, "message": message, "retryable": retryable}

    def start(self) -> tuple[bool, dict[str, Any]]:
        with self.lifecycle_lock, self.lock:
            if self.closed:
                return False, error_body("CONNECTOR_CLOSED", "连接器已关闭", retryable=False)
            if self.process is not None and self.process.poll() is None:
                return False, error_body("ALREADY_RUNNING", "该连接器只允许一个由本会话启动的决策服务", retryable=False)
            # The exit monitor may still be waiting for this lock. Finalize the
            # previous generation before its identity is replaced by a restart.
            for run in self.runs.values():
                if run.status in {"queued", "running"}:
                    run.status = "failed"
                    run.error = {"code": "PROVIDER_EXITED", "message": "本地决策服务异常退出"}
                    run.finished_at = time.time()
            if not self._port_is_free():
                self._set_provider_error("PORT_OCCUPIED", "决策服务端口已被其他程序占用", retryable=True)
                return False, error_body("PORT_OCCUPIED", "决策服务端口已被其他程序占用", retryable=True, port=self.provider_port)
            try:
                kwargs: dict[str, Any] = {
                    "stdin": subprocess.PIPE,
                    "stdout": subprocess.PIPE,
                    "stderr": subprocess.PIPE,
                    "text": True,
                    "encoding": "utf-8",
                    "bufsize": 1,
                    "env": self._provider_env(),
                }
                if os.name == "nt":
                    kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
                else:
                    kwargs["start_new_session"] = True
                # The guardian establishes ownership before the adapter can
                # spawn descendants, and watches this connector's lifetime.
                command = [sys.executable, str(Path(__file__).resolve().with_name("provider_guard.py")),
                           str(os.getpid()), *self.provider_command]
                self.process = subprocess.Popen(command, **kwargs)
            except (OSError, ValueError) as exc:
                self.process = None
                self._set_provider_error("PROVIDER_START_FAILED", "无法启动本地决策服务", retryable=True)
                return False, error_body("PROVIDER_START_FAILED", "无法启动本地决策服务", retryable=True, detail=str(exc))
            self.provider_state = "starting"
            self.provider_error = None
            self.started_at = time.time()
            self.start_deadline = time.monotonic() + self.startup_timeout
            self.write_started = None
            outgoing: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=16)
            self.outgoing = outgoing
            process = self.process
            self.reader_thread = threading.Thread(target=self._read_provider, args=(process,), daemon=True)
            self.reader_thread.start()
            threading.Thread(target=self._drain_stderr, args=(process,), daemon=True).start()
            self.monitor_thread = threading.Thread(target=self._monitor_provider, args=(process,), daemon=True)
            self.monitor_thread.start()
            threading.Thread(target=self._write_provider, args=(process, outgoing), daemon=True).start()
            threading.Thread(target=self._watch_deadlines, args=(process,), daemon=True).start()
            return True, self.health()

    def _fail_provider(self, process: subprocess.Popen[str], code: str, message: str) -> None:
        with self.lifecycle_lock:
            with self.lock:
                if process is not self.process or self.provider_state in {"error", "stopping", "offline"}:
                    return
                self._set_provider_error(code, message)
                self.provider_state = "stopping"
                for run in self.runs.values():
                    if run.status in {"queued", "running"}:
                        run.status = "failed"
                        run.error = {"code": code, "message": message}
                        run.finished_at = time.time()
            self._terminate_owned(process)
            with self.lock:
                if process is self.process or self.process is None:
                    self.process = None
                    self._set_provider_error(code, message)

    def _write_provider(self, process: subprocess.Popen[str], outgoing: queue.Queue[dict[str, Any]]) -> None:
        # Only this thread owns stdin. Killing the owned process on deadline
        # unblocks a full pipe; closing a blocked TextIO stream under a lock
        # would deadlock the stop/health request handlers again.
        assert process.stdin is not None
        try:
            while process.poll() is None:
                try:
                    message = outgoing.get(timeout=0.05)
                except queue.Empty:
                    continue
                with self.lock:
                    if process is not self.process or self.provider_state != "ready":
                        return
                    run = self.runs.get(message["runId"])
                    if message["op"] == "decide":
                        if run is None or run.status == "canceled":
                            continue
                        run.status = "running"
                    self.write_started = time.monotonic()
                try:
                    process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
                    process.stdin.flush()
                finally:
                    with self.lock:
                        if process is self.process:
                            self.write_started = None
        except (OSError, ValueError):
            self._fail_provider(process, "PROVIDER_UNAVAILABLE", "本地决策服务连接已断开")
        finally:
            try:
                process.stdin.close()
            except (OSError, ValueError):
                pass

    def _watch_deadlines(self, process: subprocess.Popen[str]) -> None:
        while process.poll() is None:
            code = None
            with self.lock:
                if process is not self.process or self.provider_state in {"error", "offline", "stopping"}:
                    return
                now = time.monotonic()
                if self.provider_state == "starting" and self.start_deadline is not None and now >= self.start_deadline:
                    code = "STARTUP_TIMEOUT"
                elif self.write_started is not None and now - self.write_started >= self.write_timeout:
                    code = "WRITE_TIMEOUT"
                elif any(run.status in {"queued", "running"} and now - run.submitted_at >= self.inference_timeout
                         for run in self.runs.values()):
                    code = "INFERENCE_TIMEOUT"
            if code:
                self._fail_provider(process, code, "本地决策服务操作超时；请重连后重试")
                return
            time.sleep(0.02)

    @staticmethod
    def _drain_stderr(process: subprocess.Popen[str]) -> None:
        # A noisy provider must not block on a full stderr pipe.  Diagnostics
        # stay local and are intentionally not forwarded to the browser.
        if process.stderr is not None:
            try:
                for _ in process.stderr:
                    pass
            except (OSError, ValueError):
                pass
            finally:
                try:
                    process.stderr.close()
                except OSError:
                    pass

    def _read_provider(self, process: subprocess.Popen[str]) -> None:
        assert process.stdout is not None
        try:
            while True:
                line = process.stdout.readline(MAX_BODY_BYTES + 1)
                if not line:
                    break
                if len(line) > MAX_BODY_BYTES or not line.endswith("\n"):
                    self._fail_provider(process, "PROVIDER_PROTOCOL_ERROR", "决策服务消息过大或不是完整 JSONL")
                    return
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    self._fail_provider(process, "PROVIDER_PROTOCOL_ERROR", "决策服务返回了无效 JSON")
                    return
                if not isinstance(message, dict) or not isinstance(message.get("event"), str):
                    self._fail_provider(process, "PROVIDER_PROTOCOL_ERROR", "决策服务消息必须是带 event 的 JSON 对象")
                    return
                event = message["event"]
                valid = (event == "ready" and message.get("protocolVersion") == PROTOCOL_VERSION) or (
                    event in {"result", "error"} and isinstance(message.get("runId"), str) and (
                        (event == "result" and isinstance(message.get("result"), dict)
                         and set(message["result"]) == {"action", "source"}
                         and isinstance(message["result"]["action"], str)
                         and message["result"]["action"] in {"fit", "restore", "expand", "collapse", "other"}
                         and isinstance(message["result"]["source"], str)) or
                        (event == "error" and isinstance(message.get("code"), str)
                         and isinstance(message.get("message"), str))))
                if not valid:
                    self._fail_provider(process, "PROVIDER_PROTOCOL_ERROR", "决策服务消息不符合协议")
                    return
                with self.lock:
                    if process is not self.process or self.provider_state not in {"starting", "ready"}:
                        continue
                    if event == "ready":
                        if self.provider_state == "starting":
                            self.provider_state = "ready"
                        continue
                    run_id = message.get("runId")
                    run = self.runs.get(run_id)
                    if run is None or process is not self.process or run.status == "canceled":
                        continue
                    if run.status not in {"queued", "running"}:
                        continue
                    if event == "result":
                        run.status = "completed"
                        run.result = message.get("result")
                        run.finished_at = time.time()
                    elif message.get("event") == "error":
                        run.status = "failed"
                        run.error = {"code": message.get("code", "PROVIDER_ERROR"), "message": message.get("message", "决策服务返回错误")}
                        run.finished_at = time.time()
        except (OSError, ValueError):
            # The owner may close the pipe while stopping the child.
            pass
        finally:
            with self.lock:
                unexpected = process is self.process and self.provider_state in {"starting", "ready"} and process.poll() is None
            if unexpected:
                self._fail_provider(process, "PROVIDER_EXITED", "决策服务输出通道已关闭")
            try:
                process.stdout.close()
            except OSError:
                pass

    def _monitor_provider(self, process: subprocess.Popen[str]) -> None:
        code = process.wait()
        with self.lock:
            if process is not self.process:
                return
            self.process = None
            for run in self.runs.values():
                if run.status in {"queued", "running"}:
                    run.status = "failed"
                    run.error = {"code": "PROVIDER_EXITED", "message": "本地决策服务异常退出", "exitCode": code}
                    run.finished_at = time.time()
            if self.provider_state not in {"stopping", "offline", "error"}:
                self._set_provider_error("PROVIDER_EXITED", "本地决策服务异常退出", retryable=True)
            elif self.provider_state != "error":
                self.provider_state = "offline"

    def stop(self) -> tuple[bool, dict[str, Any]]:
        with self.lifecycle_lock:
            with self.lock:
                process = self.process
                if process is None or process.poll() is not None:
                    for run in self.runs.values():
                        if run.status in {"queued", "running"}:
                            run.status = "canceled"
                            run.finished_at = time.time()
                    self.process = None
                    self.provider_state = "offline"
                    return False, error_body("NOT_RUNNING", "没有由本会话启动的决策服务", retryable=False)
                self.provider_state = "stopping"
                for run in self.runs.values():
                    if run.status in {"queued", "running"}:
                        run.status = "canceled"
                        run.finished_at = time.time()
            self._terminate_owned(process)
            with self.lock:
                self.process = None
                self.provider_state = "offline"
            return True, self.health()

    @staticmethod
    def _terminate_owned(process: subprocess.Popen[str]) -> None:
        # The Popen handle is the ownership proof; no name/port based kill is used.
        try:
            if os.name == "nt":
                # Terminate the guardian by its retained process handle. Its
                # private Job handle closes and reclaims all descendants; no
                # PID lookup or external taskkill process is necessary.
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=0.5)
        except (OSError, subprocess.TimeoutExpired):
            try:
                process.kill()
                process.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                pass

    def reconnect(self) -> tuple[bool, dict[str, Any]]:
        with self.lifecycle_lock:
            self.stop()
            return self.start()

    def close(self) -> None:
        # Provider stop alone deliberately does not cancel user-selected file
        # copies. Closing the whole connector owns both kinds of work.
        with self.lifecycle_lock:
            with self.lock:
                self.closed = True
                workers = []
                for task in self.downloads.values():
                    if task.status in {"queued", "downloading"}:
                        task.cancel_event.set()
                        if task.worker is not None:
                            workers.append(task.worker)
            self.stop()
        # Never join while holding a lock used by progress/commit/cleanup.
        deadline = time.monotonic() + 1.0
        for worker in workers:
            worker.join(timeout=max(0.0, deadline - time.monotonic()))

    def decide(self, text: str) -> tuple[bool, dict[str, Any]]:
        if not isinstance(text, str) or not text.strip() or len(text) > 4000:
            return False, error_body("INVALID_INPUT", "text 必须是 1–4000 字符", retryable=False)
        with self.lock:
            process = self.process
            if process is None or process.poll() is not None or self.provider_state != "ready":
                return False, error_body("OFFLINE", "本地决策服务不可用；文字主链路可以继续使用 LLM", retryable=True, textPathAvailable=True)
            run = Run(run_id=uuid.uuid4().hex, text=text)
            self.runs[run.run_id] = run
            try:
                self.outgoing.put_nowait({"op": "decide", "runId": run.run_id, "text": text})
            except queue.Full:
                del self.runs[run.run_id]
                return False, error_body("BACKPRESSURE", "本地决策服务写入队列已满", retryable=True, textPathAvailable=True)
            return True, {"run": run.as_dict()}

    def cancel(self, run_id: str) -> tuple[bool, dict[str, Any]]:
        with self.lock:
            run = self.runs.get(run_id)
            if run is None:
                return False, error_body("RUN_NOT_FOUND", "找不到该决策请求", retryable=False)
            if run.status in {"completed", "failed", "canceled"}:
                return True, {"run": run.as_dict()}
            run.status = "canceled"
            run.finished_at = time.time()
            if self.process is not None and self.provider_state == "ready":
                try:
                    self.outgoing.put_nowait({"op": "cancel", "runId": run_id})
                except queue.Full:
                    pass
            return True, {"run": run.as_dict()}

    def health(self) -> dict[str, Any]:
        with self.lock:
            alive = self.process is not None and self.process.poll() is None
            return {
                "protocolVersion": PROTOCOL_VERSION,
                "sessionId": self.session_id,
                "provider": {"state": self.provider_state, "alive": alive, "error": self.provider_error},
                "startedAt": self.started_at,
                "textPathAvailable": True,
            }

    def capabilities(self) -> dict[str, Any]:
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "transport": "http-json-loopback",
            "bind": "127.0.0.1",
            "sessionOwned": True,
            "capabilities": [
                {"id": "decision", "operations": ["health", "start", "stop", "reconnect", "decide", "cancel"]},
                {"id": "model-download", "operations": ["list", "start", "cancel"]},
            ],
        }

    def models(self) -> list[dict[str, Any]]:
        result = []
        for item in self.model_catalog:
            path = self.data_dir / str(item.get("path", f"models/{item['id']}"))
            result.append({
                "id": item["id"],
                "label": item.get("label", item["id"]),
                "sizeBytes": int(item.get("sizeBytes", 0)),
                "displayPath": path.relative_to(self.data_dir).as_posix(),
                "downloadable": bool(item.get("source")),
                "downloaded": path.exists(),
            })
        return result

    def start_download(self, model_id: str) -> tuple[bool, dict[str, Any]]:
        item = next((entry for entry in self.model_catalog if entry.get("id") == model_id), None)
        if item is None:
            return False, error_body("MODEL_NOT_FOUND", "未知模型", retryable=False)
        source_value = item.get("source")
        if not source_value:
            return False, error_body("MODEL_SOURCE_UNCONFIGURED", "模型未配置下载源；不会自动下载", retryable=False)
        source = (self.model_source_dir / str(source_value)).resolve()
        try:
            source.relative_to(self.model_source_dir)
        except ValueError:
            return False, error_body("MODEL_SOURCE_OUTSIDE_ROOT", "模型下载源必须位于受控本地目录", retryable=False)
        if not source.is_file():
            return False, error_body("MODEL_SOURCE_MISSING", "模型下载源不存在", retryable=True)
        with self.lock:
            if self.closed:
                return False, error_body("CONNECTOR_CLOSED", "连接器已关闭", retryable=False)
            if any(task.model_id == model_id and task.status in {"queued", "downloading"} for task in self.downloads.values()):
                return False, error_body("DOWNLOAD_ALREADY_RUNNING", "该模型已有下载任务", retryable=False)
            destination = (self.data_dir / str(item.get("path", f"models/{model_id}"))).resolve()
            try:
                destination.relative_to(self.data_dir)
            except ValueError:
                return False, error_body("MODEL_PATH_INVALID", "模型路径必须位于受控目录", retryable=False)
            destination.parent.mkdir(parents=True, exist_ok=True)
            task = Download(uuid.uuid4().hex, model_id, source.stat().st_size, destination)
            self.downloads[task.task_id] = task
            task.worker = threading.Thread(target=self._copy_model, args=(task, source), daemon=True)
            task.worker.start()
            return True, {"download": task.as_dict(self.data_dir)}

    def _copy_model(self, task: Download, source: Path) -> None:
        temporary = task.path.with_suffix(task.path.suffix + ".part")
        with self.lock:
            task.status = "downloading"
        try:
            with source.open("rb") as src, temporary.open("wb") as dst:
                while True:
                    if task.cancel_event.is_set():
                        raise InterruptedError
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    dst.write(chunk)
                    with self.lock:
                        task.completed += len(chunk)
                    time.sleep(0.001)
            with self.lock:
                # Cancellation and the final commit share a lock. A cancel
                # accepted after the last read must not overwrite an installed
                # file, including when the final chunk was empty.
                if task.cancel_event.is_set():
                    raise InterruptedError
                temporary.replace(task.path)
                task.status = "completed"
        except InterruptedError:
            temporary.unlink(missing_ok=True)
            with self.lock:
                task.status = "canceled"
        except OSError as exc:
            temporary.unlink(missing_ok=True)
            with self.lock:
                task.status = "failed"
                task.error = str(exc)

    def cancel_download(self, task_id: str) -> tuple[bool, dict[str, Any]]:
        with self.lock:
            task = self.downloads.get(task_id)
            if task is None:
                return False, error_body("DOWNLOAD_NOT_FOUND", "找不到该下载任务", retryable=False)
            if task.status in {"queued", "downloading"}:
                task.cancel_event.set()
            return True, {"download": task.as_dict(self.data_dir)}


class ConnectorHandler(BaseHTTPRequestHandler):
    server: "ConnectorHTTPServer"
    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        super().setup()
        # Also bound idle request/header reads before do_POST is entered.
        self.connection.settimeout(self.server.request_timeout)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        # Do not log authorization headers, request bodies, or user text.
        return

    @property
    def state(self) -> ConnectorState:
        return self.server.state

    def _send(self, status: int, body: dict[str, Any]) -> None:
        payload = json_bytes(body)
        # One request per connection also discards unread rejected/unauthorized
        # bodies instead of interpreting their bytes as a second HTTP request.
        self.close_connection = True
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(payload)
        except OSError:
            # A client may disconnect while a bounded request is completing.
            pass

    def _read_json(self) -> tuple[Optional[dict[str, Any]], Optional[dict[str, Any]]]:
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get_all("Transfer-Encoding") or len(lengths) > 1:
            return None, error_body("INVALID_BODY", "不支持重复长度或 Transfer-Encoding", retryable=False)
        length_text = lengths[0] if lengths else "0"
        if not length_text.isascii() or not length_text.isdecimal():
            return None, error_body("INVALID_BODY", "Content-Length 无效", retryable=False)
        # Compare before int() so even an excessively long decimal header
        # cannot raise the interpreter's integer-conversion length error.
        normalized_length = length_text.lstrip("0") or "0"
        if len(normalized_length) > len(str(MAX_BODY_BYTES)):
            return None, error_body("BODY_TOO_LARGE", "请求体过大", retryable=False)
        length = int(normalized_length)
        if length > MAX_BODY_BYTES:
            return None, error_body("BODY_TOO_LARGE", "请求体过大", retryable=False)
        try:
            # An absolute deadline prevents a trickling client from renewing
            # an inactivity timeout indefinitely. read1 returns available
            # bytes after at most one socket read, unlike read(length).
            deadline = time.monotonic() + self.server.request_timeout
            raw = bytearray()
            while len(raw) < length:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError
                self.connection.settimeout(remaining)
                chunk = self.rfile.read1(length - len(raw))
                if not chunk:
                    return None, error_body("INVALID_BODY", "请求体长度不足", retryable=False)
                raw.extend(chunk)
            value = json.loads(raw.decode("utf-8")) if raw else {}
        except TimeoutError:
            return None, error_body("REQUEST_TIMEOUT", "读取请求体超时", retryable=True)
        except OSError:
            return None, error_body("INVALID_BODY", "请求体读取中断", retryable=False)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, error_body("INVALID_JSON", "请求体必须是 JSON", retryable=False)
        finally:
            self.connection.settimeout(self.server.request_timeout)
        if not isinstance(value, dict):
            return None, error_body("INVALID_JSON", "请求体必须是 JSON 对象", retryable=False)
        return value, None

    def _auth(self) -> bool:
        if self.headers.get("Authorization") != f"Bearer {self.state.token}":
            self._send(HTTPStatus.UNAUTHORIZED, error_body("UNAUTHORIZED", "需要本地会话凭据", retryable=False))
            return False
        return True

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/healthz":
            self._send(HTTPStatus.OK, {"ok": True, "protocolVersion": PROTOCOL_VERSION})
            return
        if not self._auth():
            return
        if path == "/v1/health":
            self._send(HTTPStatus.OK, self.state.health())
        elif path == "/v1/capabilities":
            self._send(HTTPStatus.OK, self.state.capabilities())
        elif path == "/v1/models":
            self._send(HTTPStatus.OK, {"models": self.state.models()})
        elif path.startswith("/v1/runs/"):
            run = self.state.runs.get(path.rsplit("/", 1)[-1])
            self._send(HTTPStatus.OK if run else HTTPStatus.NOT_FOUND, {"run": run.as_dict()} if run else error_body("RUN_NOT_FOUND", "找不到该决策请求"))
        elif path.startswith("/v1/downloads/"):
            task = self.state.downloads.get(path.rsplit("/", 1)[-1])
            self._send(HTTPStatus.OK if task else HTTPStatus.NOT_FOUND, {"download": task.as_dict(self.state.data_dir)} if task else error_body("DOWNLOAD_NOT_FOUND", "找不到该下载任务"))
        else:
            self._send(HTTPStatus.NOT_FOUND, error_body("NOT_FOUND", "未知端点", retryable=False))

    def do_POST(self) -> None:  # noqa: N802
        if not self._auth():
            return
        path = urlparse(self.path).path
        body, body_error = self._read_json()
        if body_error:
            status = HTTPStatus.REQUEST_TIMEOUT if body_error["error"]["code"] == "REQUEST_TIMEOUT" else HTTPStatus.BAD_REQUEST
            self._send(status, body_error)
            return
        assert body is not None
        if path == "/v1/service/start":
            ok, response = self.state.start()
            self._send(HTTPStatus.OK if ok else HTTPStatus.CONFLICT, response)
        elif path == "/v1/service/stop":
            ok, response = self.state.stop()
            self._send(HTTPStatus.OK if ok else HTTPStatus.CONFLICT, response)
        elif path == "/v1/service/reconnect":
            ok, response = self.state.reconnect()
            self._send(HTTPStatus.OK if ok else HTTPStatus.CONFLICT, response)
        elif path == "/v1/decide":
            ok, response = self.state.decide(body.get("text"))
            self._send(HTTPStatus.ACCEPTED if ok else (HTTPStatus.SERVICE_UNAVAILABLE if response.get("error", {}).get("code") in {"OFFLINE", "PROVIDER_UNAVAILABLE", "BACKPRESSURE"} else HTTPStatus.BAD_REQUEST), response)
        elif path.startswith("/v1/runs/") and path.endswith("/cancel"):
            ok, response = self.state.cancel(path.split("/")[-2])
            self._send(HTTPStatus.OK if ok else HTTPStatus.NOT_FOUND, response)
        elif path == "/v1/models/download":
            ok, response = self.state.start_download(body.get("modelId"))
            self._send(HTTPStatus.ACCEPTED if ok else HTTPStatus.CONFLICT, response)
        elif path.startswith("/v1/downloads/") and path.endswith("/cancel"):
            ok, response = self.state.cancel_download(path.split("/")[-2])
            self._send(HTTPStatus.OK if ok else HTTPStatus.NOT_FOUND, response)
        else:
            self._send(HTTPStatus.NOT_FOUND, error_body("NOT_FOUND", "未知端点", retryable=False))


class ConnectorHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_timeout = 5.0

    def __init__(self, address: tuple[str, int], state: ConnectorState):
        super().__init__(address, ConnectorHandler)
        self.state = state

    def server_close(self) -> None:
        # Closing the HTTP server is also a lifecycle boundary.  This keeps a
        # provider from surviving a test runner or embedding host shutdown.
        state = getattr(self, "state", None)
        if state is not None:
            state.close()
        super().server_close()


def run_server(args: argparse.Namespace) -> int:
    provider_command = args.provider_command or None
    state = ConnectorState(
        Path(args.data_dir),
        provider_command=provider_command,
        provider_port=args.provider_port,
        model_source_dir=Path(args.model_source_dir) if args.model_source_dir else None,
        write_timeout=args.write_timeout,
        startup_timeout=args.startup_timeout,
        inference_timeout=args.inference_timeout,
    )
    try:
        server = ConnectorHTTPServer(("127.0.0.1", args.port), state)
    except OSError as exc:
        print(json.dumps(error_body("PORT_OCCUPIED", "连接器端口已被占用", retryable=True, port=args.port), ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps({"ready": True, "port": server.server_port, "sessionId": state.session_id, "token": state.token}, ensure_ascii=False), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Vivic local decision connector")
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="start the localhost connector")
    serve.add_argument("--port", type=int, default=DEFAULT_PORT)
    serve.add_argument("--data-dir", default=str(Path.home() / ".vivic" / "connector"))
    serve.add_argument("--model-source-dir")
    serve.add_argument("--provider-port", type=int)
    def positive_seconds(value: str) -> float:
        seconds = float(value)
        if not 0 < seconds < float("inf"):
            raise argparse.ArgumentTypeError("must be positive finite seconds")
        return seconds

    serve.add_argument("--write-timeout", type=positive_seconds, default=2.0)
    serve.add_argument("--startup-timeout", type=positive_seconds, default=15.0)
    serve.add_argument("--inference-timeout", type=positive_seconds, default=30.0)
    serve.add_argument("--provider-command", nargs=argparse.REMAINDER, help="command after --provider-command")
    return parser.parse_args(argv)


if __name__ == "__main__":
    arguments = parse_args()
    raise SystemExit(run_server(arguments))
