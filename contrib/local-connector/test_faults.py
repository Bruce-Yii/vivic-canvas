"""Real CLI/HTTP regressions for blocked and faulty provider processes.

These tests use ephemeral loopback ports and synthetic subprocesses, do not
contact model services, and keep the connector's session credential in memory.
"""

from __future__ import annotations

import concurrent.futures
import ctypes
import json
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def process_alive(pid: int) -> bool:
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        # A reparented zombie has already exited and cannot execute work.
        status = Path(f"/proc/{pid}/stat")
        return not (status.exists() and status.read_text().split()[2] == "Z")
    except ProcessLookupError:
        return False


def kill_tree(pid: int) -> None:
    if not process_alive(pid):
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=5, check=False)
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


class RunningConnector:
    """External process harness with cleanup independent of HTTP health/locks."""

    def __init__(self, mode: str, *flags: str) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.pid_file = self.root / "pids.json"
        self.stderr = (self.root / "stderr.txt").open("w+", encoding="utf-8")
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "connector.py"), "serve", "--port", "0",
             "--data-dir", str(self.root / "data"), *flags, "--provider-command",
             sys.executable, str(ROOT / "fault_provider.py"), mode, "--pids", str(self.pid_file)],
            stdout=subprocess.PIPE, stderr=self.stderr, text=True, encoding="utf-8",
        )
        self.base = ""
        self.token = ""
        try:
            lines: queue.Queue[str] = queue.Queue()
            threading.Thread(target=lambda: lines.put(self.process.stdout.readline()), daemon=True).start()
            line = lines.get(timeout=5)
            if not line:
                self.stderr.seek(0)
                raise RuntimeError("connector failed to start: " + self.stderr.read())
            ready = json.loads(line)
            self.base = f"http://127.0.0.1:{ready['port']}"
            self.token = ready["token"]
            status, _ = self.request("POST", "/v1/service/start")
            if status != 200:
                raise RuntimeError(f"provider start returned {status}")
        except BaseException:
            self.close()
            raise

    def __enter__(self) -> "RunningConnector":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def pids(self) -> list[int]:
        return json.loads(self.pid_file.read_text(encoding="utf-8")) if self.pid_file.exists() else []

    def close(self) -> None:
        # Kill the connector tree directly, even when all HTTP handlers deadlock.
        kill_tree(self.process.pid)
        self.process.wait(timeout=5)
        for pid in self.pids():
            kill_tree(pid)
        if self.process.stdout is not None:
            self.process.stdout.close()
        self.stderr.close()
        self.temp.cleanup()

    def request(self, method: str, path: str, body: dict | None = None,
                timeout: float = 2) -> tuple[int, dict]:
        data = json.dumps(body or {}).encode() if method == "POST" else None
        request = urllib.request.Request(self.base + path, data=data, method=method,
                                         headers={"Authorization": "Bearer " + self.token,
                                                  "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, json.loads(exc.read())
            finally:
                exc.close()

    def wait_provider(self, expected: str, seconds: float = 4) -> dict:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            _, health = self.request("GET", "/v1/health")
            if health["provider"]["state"] == expected:
                return health
            time.sleep(0.02)
        raise AssertionError(f"provider did not reach {expected}: {health}")

    def wait_run(self, run_id: str, seconds: float = 4) -> dict:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            _, body = self.request("GET", f"/v1/runs/{run_id}")
            if body["run"]["status"] in {"failed", "completed", "canceled"}:
                return body["run"]
            time.sleep(0.02)
        raise AssertionError(f"run did not terminate: {body}")


class ConnectorFaultTest(unittest.TestCase):
    def test_stdin_backpressure_does_not_block_health_or_stop(self) -> None:
        # No short timeout flags: this also reproduces the original implementation.
        with RunningConnector("no-read") as connector:
            connector.wait_provider("ready")
            with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
                requests = [pool.submit(connector.request, "POST", "/v1/decide",
                                        {"text": "x" * 4000}, 4) for _ in range(24)]
                time.sleep(0.15)  # Give writers time to fill the real OS pipe.
                start = time.monotonic()
                status, _ = connector.request("GET", "/v1/health", timeout=0.8)
                self.assertEqual(status, 200)
                self.assertLess(time.monotonic() - start, 0.8)
                start = time.monotonic()
                status, body = connector.request("POST", "/v1/service/stop", timeout=3)
                self.assertIn(status, {200, 409})  # A write deadline may stop it first.
                self.assertLess(time.monotonic() - start, 3)
                if status == 200:
                    self.assertEqual(body["provider"]["state"], "offline")
                # Every submission must return a protocol response, not a timeout.
                for future in requests:
                    self.assertIn(future.result()[0], {202, 429, 503})

    def test_blocked_write_deadline_fails_runs_and_reclaims_provider(self) -> None:
        with RunningConnector("no-read", "--write-timeout", "0.3") as connector:
            connector.wait_provider("ready")
            accepted = []
            for _ in range(24):
                status, body = connector.request("POST", "/v1/decide", {"text": "x" * 4000})
                self.assertIn(status, {202, 503})
                if status == 202:
                    accepted.append(body["run"]["runId"])
            self.assertTrue(accepted)
            health = connector.wait_provider("error")
            self.assertEqual(health["provider"]["error"]["code"], "WRITE_TIMEOUT")
            self.assertFalse(health["provider"]["alive"])
            for run_id in accepted:
                run = connector.wait_run(run_id)
                self.assertEqual(run["status"], "failed")
                self.assertEqual(run["error"]["code"], "WRITE_TIMEOUT")
            self.assertFalse(any(process_alive(pid) for pid in connector.pids()))

    def test_cancel_during_backpressure_returns_without_writing_pipe(self) -> None:
        with RunningConnector("no-read") as connector:
            connector.wait_provider("ready")
            accepted = []
            for _ in range(24):
                status, body = connector.request("POST", "/v1/decide", {"text": "x" * 4000})
                self.assertIn(status, {202, 503})
                if status == 202:
                    accepted.append(body["run"]["runId"])
            self.assertTrue(accepted)
            start = time.monotonic()
            status, body = connector.request("POST", f"/v1/runs/{accepted[-1]}/cancel", timeout=0.8)
            self.assertEqual(status, 200)
            self.assertEqual(body["run"]["status"], "canceled")
            self.assertLess(time.monotonic() - start, 0.8)
            status, _ = connector.request("POST", "/v1/service/stop", timeout=3)
            self.assertEqual(status, 200)
            _, body = connector.request("GET", f"/v1/runs/{accepted[-1]}")
            self.assertEqual(body["run"]["status"], "canceled")

    def test_startup_timeout_reclaims_provider(self) -> None:
        with RunningConnector("startup-hang", "--startup-timeout", "0.3") as connector:
            health = connector.wait_provider("error")
            self.assertEqual(health["provider"]["error"]["code"], "STARTUP_TIMEOUT")
            self.assertFalse(health["provider"]["alive"])

    def test_inference_timeout_fails_run_and_reclaims_provider(self) -> None:
        with RunningConnector("inference-hang", "--inference-timeout", "0.3") as connector:
            connector.wait_provider("ready")
            status, body = connector.request("POST", "/v1/decide", {"text": "synthetic timeout"})
            self.assertEqual(status, 202)
            run = connector.wait_run(body["run"]["runId"])
            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["error"]["code"], "INFERENCE_TIMEOUT")
            health = connector.wait_provider("error")
            self.assertFalse(health["provider"]["alive"])

    def test_non_object_provider_message_is_reported(self) -> None:
        with RunningConnector("array") as connector:
            connector.wait_provider("ready")
            status, body = connector.request("POST", "/v1/decide", {"text": "synthetic array"})
            self.assertEqual(status, 202)
            run = connector.wait_run(body["run"]["runId"])
            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["error"]["code"], "PROVIDER_PROTOCOL_ERROR")
            self.assertEqual(connector.wait_provider("error")["provider"]["error"]["code"],
                             "PROVIDER_PROTOCOL_ERROR")

    def test_invalid_result_shape_action_and_fields_are_rejected(self) -> None:
        for mode in ("result-list", "unknown-action", "extra-field"):
            with self.subTest(mode=mode), RunningConnector(mode) as connector:
                connector.wait_provider("ready")
                status, body = connector.request("POST", "/v1/decide", {"text": "synthetic invalid result"})
                self.assertEqual(status, 202)
                run = connector.wait_run(body["run"]["runId"])
                self.assertEqual(run["status"], "failed")
                self.assertEqual(run["error"]["code"], "PROVIDER_PROTOCOL_ERROR")
                self.assertNotIn("result", run)
                health = connector.wait_provider("error")
                self.assertFalse(health["provider"]["alive"])

    def test_late_provider_messages_cannot_overwrite_terminal_run(self) -> None:
        with RunningConnector("late-events") as connector:
            connector.wait_provider("ready")
            status, body = connector.request("POST", "/v1/decide", {"text": "synthetic terminal run"})
            self.assertEqual(status, 202)
            run_id = body["run"]["runId"]
            completed = connector.wait_run(run_id)
            self.assertEqual(completed["status"], "completed")
            self.assertEqual(completed["result"]["action"], "fit")
            time.sleep(0.3)
            _, body = connector.request("GET", f"/v1/runs/{run_id}")
            self.assertEqual(body["run"], completed)

    def test_mock_cancel_interrupts_wait_and_next_request_is_not_serialized(self) -> None:
        process = subprocess.Popen([sys.executable, str(ROOT / "mock_provider.py"), "--delay", "1"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True, encoding="utf-8")
        output: queue.Queue[dict] = queue.Queue()

        def collect() -> None:
            for line in process.stdout:
                output.put(json.loads(line))

        reader = threading.Thread(target=collect, daemon=True)
        reader.start()
        try:
            self.assertEqual(output.get(timeout=3)["event"], "ready")
            process.stdin.write(json.dumps({"op": "decide", "runId": "canceled-fixture", "text": "cancel"}) + "\n")
            process.stdin.flush()
            time.sleep(0.1)
            start = time.monotonic()
            process.stdin.write(json.dumps({"op": "cancel", "runId": "canceled-fixture"}) + "\n")
            process.stdin.write(json.dumps({"op": "decide", "runId": "next-fixture", "text": "next"}) + "\n")
            process.stdin.flush()
            result = output.get(timeout=1.45)
            self.assertEqual(result["runId"], "next-fixture")
            self.assertLess(time.monotonic() - start, 1.45)
            # Suppression is checked at the provider output, not only the HTTP
            # terminal status that could otherwise hide continued computation.
            with self.assertRaises(queue.Empty):
                output.get(timeout=1.1)
        finally:
            process.kill()
            process.wait(timeout=3)
            process.stdin.close()
            reader.join(timeout=1)
            process.stdout.close()

    def test_abrupt_connector_exit_reclaims_provider_tree(self) -> None:
        with RunningConnector("tree") as connector:
            connector.wait_provider("ready")
            pids = connector.pids()
            self.assertEqual(len(pids), 2)
            self.assertTrue(all(process_alive(pid) for pid in pids))
            connector.process.kill()  # Kill parent only; do not perform harness tree cleanup yet.
            connector.process.wait(timeout=3)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and any(process_alive(pid) for pid in pids):
                time.sleep(0.02)
            self.assertFalse(any(process_alive(pid) for pid in pids),
                             "owned provider or descendant survived connector exit")

    def test_stop_reclaims_owned_tree_and_preserves_unrelated_process(self) -> None:
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            with RunningConnector("tree") as connector:
                connector.wait_provider("ready")
                pids = connector.pids()
                self.assertEqual(len(pids), 2)
                self.assertTrue(all(process_alive(pid) for pid in pids))
                status, body = connector.request("POST", "/v1/service/stop", timeout=3)
                self.assertEqual(status, 200)
                self.assertEqual(body["provider"]["state"], "offline")
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and any(process_alive(pid) for pid in pids):
                    time.sleep(0.02)
                self.assertFalse(any(process_alive(pid) for pid in pids))
                self.assertIsNone(unrelated.poll(), "stop killed a process outside its ownership")
        finally:
            unrelated.kill()
            unrelated.wait(timeout=3)


if __name__ == "__main__":
    unittest.main()
