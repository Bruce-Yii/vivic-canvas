from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from connector import ConnectorHTTPServer, ConnectorState  # noqa: E402


MOCK = str(Path(__file__).resolve().with_name("mock_provider.py"))


class ConnectorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        # tempfile may return an 8.3 alias on Windows; compare canonical roots.
        self.temp_root = Path(self.temp.name).resolve()
        self.state = ConnectorState(
            self.temp_root / "data",
            provider_command=[sys.executable, MOCK, "--delay", "0.15"],
        )
        self.server = ConnectorHTTPServer(("127.0.0.1", 0), self.state)
        import threading

        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.state.stop()
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def request(self, method: str, path: str, body: dict | None = None, auth: bool = True) -> tuple[int, dict]:
        data = json.dumps(body or {}).encode()
        request = urllib.request.Request(self.base + path, data=data if method == "POST" else None, method=method)
        if method == "POST":
            request.add_header("Content-Type", "application/json")
        if auth:
            request.add_header("Authorization", f"Bearer {self.state.token}")
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, json.loads(exc.read())
            finally:
                exc.close()

    def wait_ready(self) -> None:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            health = self.state.health()
            if health["provider"]["state"] == "ready":
                return
            if health["provider"]["state"] == "error":
                self.fail(f"provider startup failed: {health['provider']['error']}")
            time.sleep(0.01)
        self.fail(f"provider did not become ready: {self.state.health()['provider']}")

    def test_liveness_is_public_but_capabilities_are_session_bound(self) -> None:
        status, body = self.request("GET", "/healthz", auth=False)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        status, body = self.request("GET", "/v1/capabilities", auth=False)
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "UNAUTHORIZED")
        status, body = self.request("GET", "/v1/capabilities")
        self.assertEqual(status, 200)
        self.assertEqual(body["bind"], "127.0.0.1")
        self.assertTrue(body["sessionOwned"])

    def test_offline_does_not_block_text_path_and_start_is_idempotent_guarded(self) -> None:
        status, body = self.request("POST", "/v1/decide", {"text": "显示全部"})
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "OFFLINE")
        self.assertTrue(body["error"]["textPathAvailable"])
        status, _ = self.request("POST", "/v1/service/start")
        self.assertEqual(status, 200)
        self.wait_ready()
        status, body = self.request("POST", "/v1/service/start")
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "ALREADY_RUNNING")

    def test_decide_cancel_stop_and_reconnect_only_own_process(self) -> None:
        status, _ = self.request("POST", "/v1/service/start")
        self.assertEqual(status, 200)
        self.wait_ready()
        status, body = self.request("POST", "/v1/decide", {"text": "显示全部"})
        self.assertEqual(status, 202)
        run_id = body["run"]["runId"]
        status, body = self.request("POST", f"/v1/runs/{run_id}/cancel")
        self.assertEqual(status, 200)
        self.assertEqual(body["run"]["status"], "canceled")
        status, body = self.request("POST", "/v1/service/reconnect")
        self.assertEqual(status, 200)
        self.wait_ready()
        status, body = self.request("POST", "/v1/decide", {"text": "显示全部"})
        self.assertEqual(status, 202)
        run_id = body["run"]["runId"]
        for _ in range(40):
            _, body = self.request("GET", f"/v1/runs/{run_id}")
            if body["run"]["status"] == "completed":
                break
            time.sleep(0.02)
        self.assertEqual(body["run"]["result"]["action"], "fit")
        status, body = self.request("POST", "/v1/service/stop")
        self.assertEqual(status, 200)
        self.assertEqual(body["provider"]["state"], "offline")

    def test_port_occupied_is_reported_without_killing_owner(self) -> None:
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen(1)
            port = occupied.getsockname()[1]
            state = ConnectorState(self.temp_root / "other", provider_port=port)
            ok, body = state.start()
            self.assertFalse(ok)
            self.assertEqual(body["error"]["code"], "PORT_OCCUPIED")
            self.assertIsNone(state.process)

    def test_connector_port_occupied_fails_without_reusing_socket(self) -> None:
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen(1)
            state = ConnectorState(self.temp_root / "occupied")
            with self.assertRaises(OSError):
                ConnectorHTTPServer(("127.0.0.1", occupied.getsockname()[1]), state)
            self.assertIsNone(state.process)

    def test_provider_abnormal_exit_is_reported_and_not_restarted_implicitly(self) -> None:
        crash = self.temp_root / "crash_provider.py"
        crash.write_text(
            "import json; print(json.dumps({'event':'ready','protocolVersion':'0.1'}), flush=True)",
            encoding="utf-8",
        )
        state = ConnectorState(self.temp_root / "crash", provider_command=[sys.executable, str(crash)])
        ok, _ = state.start()
        self.assertTrue(ok)
        for _ in range(40):
            if state.health()["provider"]["state"] == "error":
                break
            time.sleep(0.01)
        self.assertEqual(state.health()["provider"]["error"]["code"], "PROVIDER_EXITED")
        self.assertIsNone(state.process)

    def test_restart_before_exit_monitor_does_not_leave_old_runs_active(self) -> None:
        self.state.inference_timeout = 0.4
        self.assertTrue(self.state.start()[0])
        self.wait_ready()
        # Holding the state lock gates the real reader/writer/exit monitor,
        # deterministically scheduling start() before the old monitor can run.
        with self.state.lock:
            ok, response = self.state.decide("显示全部")
            self.assertTrue(ok)
            run_id = response["run"]["runId"]
            old_process = self.state.process
            self.assertIsNotNone(old_process)
            self.state._terminate_owned(old_process)
            self.assertIsNotNone(old_process.poll())
            time.sleep(0.45)  # Old request would expire the new generation.
            self.assertTrue(self.state.start()[0])
            self.assertEqual(self.state.runs[run_id].status, "failed")
        self.wait_ready()
        time.sleep(0.5)
        self.assertEqual(self.state.health()["provider"]["state"], "ready")

    def test_stop_before_exit_monitor_finalizes_old_runs(self) -> None:
        self.assertTrue(self.state.start()[0])
        self.wait_ready()
        with self.state.lock:
            ok, response = self.state.decide("显示全部")
            self.assertTrue(ok)
            run_id = response["run"]["runId"]
            old_process = self.state.process
            self.assertIsNotNone(old_process)
            self.state._terminate_owned(old_process)
            self.assertIsNotNone(old_process.poll())
            self.state.stop()
            self.assertIn(self.state.runs[run_id].status, {"failed", "canceled"})

    def test_explicit_model_download_can_be_canceled(self) -> None:
        source_dir = (self.temp_root / "sources").resolve()
        source_dir.mkdir()
        (source_dir / "fixture.bin").write_bytes(os.urandom(64 * 1024 * 1024))
        self.state.model_source_dir = source_dir
        self.state.model_catalog.append({
            "id": "fixture-model",
            "label": "test fixture",
            "sizeBytes": 64 * 1024 * 1024,
            "source": "fixture.bin",
            "path": "models/fixture.bin",
        })
        status, body = self.request("POST", "/v1/models/download", {"modelId": "fixture-model"})
        self.assertEqual(status, 202)
        task_id = body["download"]["taskId"]
        status, body = self.request("POST", f"/v1/downloads/{task_id}/cancel")
        self.assertEqual(status, 200)
        for _ in range(100):
            _, body = self.request("GET", f"/v1/downloads/{task_id}")
            if body["download"]["status"] in {"canceled", "completed", "failed"}:
                break
            time.sleep(0.005)
        self.assertEqual(body["download"]["status"], "canceled")
        self.assertFalse((self.temp_root / "data" / "models" / "fixture.bin").exists())

    def test_model_catalog_never_downloads_without_explicit_source(self) -> None:
        status, body = self.request("GET", "/v1/models")
        self.assertEqual(status, 200)
        self.assertFalse(body["models"][0]["downloadable"])
        status, body = self.request("POST", "/v1/models/download", {"modelId": "mock-decision"})
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "MODEL_SOURCE_UNCONFIGURED")


if __name__ == "__main__":
    unittest.main()
