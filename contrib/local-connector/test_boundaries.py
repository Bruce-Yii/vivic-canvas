"""Real HTTP framing and deterministic local-copy cancellation regressions."""

from __future__ import annotations

import contextlib
import http.client
import json
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from connector import ConnectorHTTPServer, ConnectorState  # noqa: E402


class ConnectorBoundaryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.state = ConnectorState(self.root / "data")
        self.server = ConnectorHTTPServer(("127.0.0.1", 0), self.state)
        self.server.request_timeout = 0.25
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def raw_post(self, framing: str, body: bytes = b"{}") -> tuple[int, dict, str | None]:
        with socket.create_connection(self.server.server_address, timeout=1) as connection:
            request = (
                "POST /v1/service/stop HTTP/1.1\r\nHost: localhost\r\n"
                f"Authorization: Bearer {self.state.token}\r\n{framing}\r\n\r\n"
            ).encode("ascii")
            connection.sendall(request + body)
            with http.client.HTTPResponse(connection) as response:
                response.begin()
                return response.status, json.loads(response.read()), response.getheader("Connection")

    def test_negative_length_rejected_without_waiting_for_client_eof(self) -> None:
        status, body, connection = self.raw_post("Content-Length: -1")
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "INVALID_BODY")
        self.assertEqual(connection, "close")

    def test_ambiguous_framing_is_rejected_and_connection_closed(self) -> None:
        for framing in (
            "Content-Length: 2\r\nContent-Length: 3",
            "Content-Length: 2\r\nTransfer-Encoding: chunked",
        ):
            with self.subTest(framing=framing):
                status, body, connection = self.raw_post(framing)
                self.assertEqual(status, 400)
                self.assertEqual(body["error"]["code"], "INVALID_BODY")
                self.assertEqual(connection, "close")

    def test_early_eof_does_not_accept_short_but_valid_json(self) -> None:
        with socket.create_connection(self.server.server_address, timeout=1) as connection:
            request = (
                "POST /v1/service/stop HTTP/1.1\r\nHost: localhost\r\n"
                f"Authorization: Bearer {self.state.token}\r\nContent-Length: 9\r\n\r\n{{}}"
            ).encode("ascii")
            connection.sendall(request)
            connection.shutdown(socket.SHUT_WR)
            with http.client.HTTPResponse(connection) as response:
                response.begin()
                body = json.loads(response.read())
                self.assertEqual(response.status, 400)
                self.assertEqual(body["error"]["code"], "INVALID_BODY")

    def test_incomplete_body_has_bounded_read_deadline(self) -> None:
        started = time.monotonic()
        status, body, connection = self.raw_post("Content-Length: 3", b"{")
        self.assertEqual(status, 408)
        self.assertEqual(body["error"]["code"], "REQUEST_TIMEOUT")
        self.assertEqual(connection, "close")
        self.assertLess(time.monotonic() - started, 0.8)

    def test_trickled_body_cannot_reset_total_read_deadline(self) -> None:
        with socket.create_connection(self.server.server_address, timeout=1) as connection:
            request = (
                "POST /v1/service/stop HTTP/1.1\r\nHost: localhost\r\n"
                f"Authorization: Bearer {self.state.token}\r\nContent-Length: 12\r\n\r\n"
            ).encode("ascii")
            connection.sendall(request + b"{")

            def trickle() -> None:
                for _ in range(10):
                    time.sleep(0.08)
                    try:
                        connection.sendall(b" ")
                    except OSError:
                        return

            worker = threading.Thread(target=trickle, daemon=True)
            worker.start()
            started = time.monotonic()
            try:
                with http.client.HTTPResponse(connection) as response:
                    response.begin()
                    body = json.loads(response.read())
                    self.assertEqual(response.status, 408)
                    self.assertEqual(body["error"]["code"], "REQUEST_TIMEOUT")
                    self.assertLess(time.monotonic() - started, 0.6)
            finally:
                connection.shutdown(socket.SHUT_RDWR)
                worker.join(timeout=2)

    def test_cancel_at_eof_preserves_existing_model(self) -> None:
        self.check_eof_cancellation(close_server=False)

    def test_closing_server_cancels_copy_before_committing(self) -> None:
        self.check_eof_cancellation(close_server=True)

    def check_eof_cancellation(self, *, close_server: bool) -> None:
        source_dir = self.root / "sources"
        source_dir.mkdir()
        source = source_dir / "fixture.bin"
        source.write_bytes(b"replacement fixture")
        target = self.state.data_dir / "models" / "fixture.bin"
        target.parent.mkdir()
        target.write_bytes(b"original fixture")
        self.state.model_source_dir = source_dir
        self.state.model_catalog.append({"id": "fixture", "source": "fixture.bin", "path": "models/fixture.bin"})
        at_eof = threading.Event()
        release = threading.Event()
        actual_open = Path.open

        class GatedReader:
            def __init__(self, file) -> None:
                self.file = file

            def read(self, size: int) -> bytes:
                chunk = self.file.read(size)
                if not chunk:
                    at_eof.set()
                    if not release.wait(timeout=3):
                        raise OSError("test EOF gate timed out")
                return chunk

        def open_file(path, *args, **kwargs):
            if path == source:
                @contextlib.contextmanager
                def gated():
                    with actual_open(path, *args, **kwargs) as file:
                        yield GatedReader(file)
                return gated()
            return actual_open(path, *args, **kwargs)

        with patch.object(Path, "open", open_file):
            ok, body = self.state.start_download("fixture")
            self.assertTrue(ok)
            task_id = body["download"]["taskId"]
            task = self.state.downloads[task_id]
            closer = None
            try:
                self.assertTrue(at_eof.wait(timeout=2), "fixture copy did not reach EOF")
                if close_server:
                    self.server.shutdown()
                    closer = threading.Thread(target=self.server.server_close)
                    closer.start()
                    self.assertTrue(task.cancel_event.wait(timeout=1), "server close did not cancel copy")
                else:
                    self.assertTrue(self.state.cancel_download(task_id)[0])
            finally:
                release.set()
                if closer is not None:
                    closer.join(timeout=2)
                    self.assertFalse(closer.is_alive(), "server close did not finish")
            deadline = time.monotonic() + 2
            while task.status in {"queued", "downloading"} and time.monotonic() < deadline:
                time.sleep(0.01)
        self.assertEqual(task.status, "canceled")
        self.assertEqual(target.read_bytes(), b"original fixture")
        self.assertFalse(target.with_suffix(".bin.part").exists())
        if close_server:
            self.assertEqual(self.state.start()[1]["error"]["code"], "CONNECTOR_CLOSED")
            self.assertEqual(self.state.start_download("fixture")[1]["error"]["code"], "CONNECTOR_CLOSED")


if __name__ == "__main__":
    unittest.main()
