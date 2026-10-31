"""Synthetic loopback transport tests. No real model or account is called."""
import json
import threading
import time
import unittest
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

from provider import DecisionRequest, DecisionRouter, DecisionResult, _validate_response, api_provider, local_provider


REQUEST = DecisionRequest("显示全部", {"canvas_id": "TEST"}, [
    {"id": "C1", "decision": {"route": "noop"}},
    {"id": "C2", "decision": {"route": "clarify"}},
])


class ProviderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.received = []
        cls.arrived = threading.Event()
        cls.release = threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                cls.received.append((self.path, payload, self.headers.get("Authorization")))
                if self.path == "/redirect":
                    self.send_response(307)
                    self.send_header("Location", "/redirect-target")
                    self.end_headers()
                    return
                if self.path == "/slow":
                    time.sleep(.12)
                if self.path == "/cancellable":
                    cls.arrived.set()
                    cls.release.wait(2)
                values = {
                    "/bad": {"choice_id": "C99"},
                    "/nan": {"probabilities": {"C1": float("nan"), "C2": 0}},
                    "/infinite": {"probabilities": {"C1": float("inf"), "C2": 0}},
                    "/bool": {"probabilities": {"C1": True, "C2": 0}},
                    "/sum": {"probabilities": {"C1": .4, "C2": .4}},
                    "/missing": {"probabilities": {"C1": 1}},
                    "/extra": {"probabilities": {"C1": 1, "C2": 0, "C3": 0}},
                    "/array": {"probabilities": [.9, .1]},
                    "/null-probs": {"choice_id": "C1", "probabilities": None},
                    "/null-choice": {"choice_id": None, "probabilities": {"C1": .9, "C2": .1}},
                    "/contradict": {"choice_id": "C2", "probabilities": {"C1": .9, "C2": .1}},
                    "/valid-probs": {"choice_id": "C1", "probabilities": {"C1": .9, "C2": .1}},
                    "/tie": {"probabilities": {"C2": .5, "C1": .5}},
                    "/leak": {"choice_id": "C1", "raw": "untrusted-secret-sentinel"},
                }
                value = values.get(self.path, {"choice_id": "C1"})
                if self.path.startswith("/chat/"):
                    finish = self.path.removeprefix("/chat/")
                    value = {"choices": [{"finish_reason": finish, "message": {"content": '{"choice_id":"C1"}'}}]}
                raw = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                    pass  # Expected when the timeout test closes its connection.
            def log_message(self, *_args):
                pass
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.release.set()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_api_and_local_send_only_contract_without_gold(self):
        for provider in (api_provider(self.base + "/ok"), local_provider(self.base + "/ok")):
            result = provider.decide(REQUEST)
            self.assertTrue(result.usable)
            self.assertEqual(result.choice_id, "C1")
            self.assertIsNone(result.probabilities)
            payload = self.received[-1][1]
            self.assertEqual(payload["schema_version"], "vivic-decision-provider-1")
            self.assertEqual(set(payload["input"]), {"utterance", "context", "choices"})
            self.assertEqual(payload["input"]["choices"], REQUEST.choices)
            self.assertNotIn("raw", asdict(result))

    def test_invalid_response_never_fabricates_choice_or_probabilities(self):
        for path in ("bad", "nan", "infinite", "bool", "sum", "missing", "extra", "array", "null-probs", "null-choice", "contradict", "leak"):
            with self.subTest(path=path):
                result = local_provider(self.base + "/" + path).decide(REQUEST)
                self.assertEqual(result.state, "error")
                self.assertIsNone(result.choice_id)
                self.assertIsNone(result.probabilities)
                self.assertNotIn("untrusted-secret-sentinel", repr(result))

    def test_preserves_real_candidate_probabilities_without_normalization(self):
        result = local_provider(self.base + "/valid-probs").decide(REQUEST)
        self.assertEqual(result.state, "accepted")
        self.assertEqual(result.probabilities, {"C1": .9, "C2": .1})
        self.assertEqual(result.choice_id, "C1")

    def test_probability_tie_is_deterministic_in_input_order(self):
        result = local_provider(self.base + "/tie").decide(REQUEST)
        self.assertEqual(result.choice_id, "C1")

    def test_chat_wrapper_requires_completed_final_answer(self):
        self.assertEqual(local_provider(self.base + "/chat/stop").decide(REQUEST).state, "accepted")
        for finish in ("length", "tool_calls", "content_filter", ""):
            with self.subTest(finish=finish):
                self.assertEqual(local_provider(self.base + "/chat/" + finish).decide(REQUEST).state, "error")

    def test_invalid_request_is_rejected_before_transport(self):
        count = len(self.received)
        invalid = [
            DecisionRequest("", {}, REQUEST.choices),
            DecisionRequest("hello", [], REQUEST.choices),
            DecisionRequest("hello", {}, []),
            DecisionRequest("hello", {}, [REQUEST.choices[0], REQUEST.choices[0]]),
            DecisionRequest("hello", {}, [{"id": 1, "decision": {}}]),
            DecisionRequest("hello", {}, [{"id": "x", "decision": {}, "expected": True}]),
            DecisionRequest("hello", {"bad": float("nan")}, REQUEST.choices),
        ]
        for request in invalid:
            with self.subTest(request=request):
                result = local_provider(self.base + "/ok").decide(request)
                self.assertEqual(result.state, "error")
                self.assertEqual(result.reason, "invalid_request")
        self.assertEqual(len(self.received), count)

    def test_timeout_falls_back_and_records_reason(self):
        router = DecisionRouter(api_provider(self.base + "/slow", timeout_s=.02), local_provider(self.base + "/ok"))
        result = router.decide(REQUEST)
        self.assertTrue(result.usable)
        self.assertEqual(result.provider, "local")
        self.assertEqual(result.reason, "fallback_after:timeout")

    def test_explicit_disable_and_pre_cancel_do_not_call_either_provider(self):
        primary = Mock()
        fallback = Mock()
        self.assertEqual(DecisionRouter(primary, fallback, enabled=False).decide(REQUEST).state, "disabled")
        event = threading.Event()
        event.set()
        self.assertEqual(DecisionRouter(primary, fallback).decide(REQUEST, event).state, "cancelled")
        primary.decide.assert_not_called()
        fallback.decide.assert_not_called()

    def test_cancel_during_http_discards_late_success_without_fallback(self):
        self.arrived.clear()
        self.release.clear()
        event = threading.Event()
        fallback = Mock()
        router = DecisionRouter(local_provider(self.base + "/cancellable"), fallback)
        results = []
        worker = threading.Thread(target=lambda: results.append(router.decide(REQUEST, event)))
        worker.start()
        try:
            self.assertTrue(self.arrived.wait(1))
            event.set()
            self.release.set()
            worker.join(2)
            self.assertFalse(worker.is_alive())
            self.assertEqual(results[0].state, "cancelled")
            self.assertIsNone(results[0].choice_id)
            fallback.decide.assert_not_called()
        finally:
            self.release.set()
            worker.join(2)

    def test_router_discards_injected_provider_late_success(self):
        event = threading.Event()
        def late_success(*_args):
            event.set()
            return DecisionResult("accepted", "api", "C1")
        primary = Mock()
        primary.decide.side_effect = late_success
        fallback = Mock()
        self.assertEqual(DecisionRouter(primary, fallback).decide(REQUEST, event).state, "cancelled")
        fallback.decide.assert_not_called()

    def test_router_does_not_override_uncertainty_with_fallback(self):
        primary = Mock()
        primary.decide.return_value = DecisionResult("deferred", "api", reason="uncertain")
        fallback = Mock()
        result = DecisionRouter(primary, fallback).decide(REQUEST)
        self.assertEqual(result.state, "deferred")
        fallback.decide.assert_not_called()

    def test_provider_exceptions_are_fixed_errors_without_secret_messages(self):
        primary = Mock()
        primary.decide.side_effect = RuntimeError("secret-exception-sentinel")
        direct = DecisionRouter(primary).decide(REQUEST)
        self.assertEqual(direct.state, "error")
        self.assertEqual(direct.reason, "provider_error")
        self.assertNotIn("secret-exception-sentinel", repr(direct))
        fallback = Mock()
        fallback.decide.return_value = DecisionResult("accepted", "local", "C1")
        self.assertEqual(DecisionRouter(primary, fallback).decide(REQUEST).reason, "fallback_after:error")
        fallback.decide.side_effect = RuntimeError("secret-exception-sentinel")
        both_failed = DecisionRouter(primary, fallback).decide(REQUEST)
        self.assertEqual(both_failed.state, "error")
        self.assertNotIn("secret-exception-sentinel", repr(both_failed))

    def test_shared_typescript_wire_fixture(self):
        fixture = json.loads(Path(__file__).with_name("contract-fixtures.json").read_text(encoding="utf-8"))
        inp = fixture["input"]
        request = DecisionRequest(inp["utterance"], inp["context"], inp["choices"], fixture["request_id"])
        self.assertEqual(request.as_payload(), {key: fixture[key] for key in ("schema_version", "request_id", "input")})
        for sample in fixture["responses"]:
            with self.subTest(label=sample["label"]):
                if sample["wire_valid"]:
                    choice, probabilities = _validate_response(sample["value"], request.choices)
                    self.assertEqual(choice, sample["value"].get("choice_id", choice))
                    if "probabilities" not in sample["value"]:
                        self.assertIsNone(probabilities)
                else:
                    with self.assertRaises(ValueError):
                        _validate_response(sample["value"], request.choices)

    def test_authorization_is_not_forwarded_on_redirect(self):
        with patch.dict("os.environ", {"DECISION_TEST_TOKEN": "test-only-secret"}):
            result = api_provider(self.base + "/redirect", api_key_env="DECISION_TEST_TOKEN").decide(REQUEST)
        self.assertEqual(result.state, "error")
        self.assertEqual(result.reason, "http_307")
        self.assertFalse(any(row[0] == "/redirect-target" for row in self.received))
        self.assertNotIn("test-only-secret", repr(result))

    def test_configuration_requires_finite_timeout_and_clean_endpoint(self):
        for timeout in (0, -1, True, float("nan"), float("inf"), 31):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                local_provider(self.base, timeout_s=timeout)
        for endpoint in ("file:///tmp/x", "http://", "http://user:secret@localhost/x", self.base + "/x?token=secret", self.base + "/#token"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                local_provider(endpoint)

    def test_remote_http_and_non_loopback_local_endpoints_are_rejected(self):
        for endpoint in ("http://decision.example/decide", "http://192.168.1.5/decide", "http://localhost.example/decide"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                api_provider(endpoint)
        for endpoint in ("https://decision.example/decide", "https://192.168.1.5/decide"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                local_provider(endpoint)
        api_provider("https://decision.example/decide")
        for endpoint in ("http://localhost:8789/decide", "http://127.0.0.1:8789/decide", "http://[::1]:8789/decide"):
            local_provider(endpoint)


if __name__ == "__main__":
    unittest.main()
