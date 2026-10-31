"""Runner/data tests use synthetic fixtures and a loopback fake server only."""
import copy
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import run


class RunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data, cls.digest = run.read_data()
        cls.case = cls.data["cases"][0]

    def test_export_has_no_gold_or_internal_annotations(self):
        inp = run.model_input(self.case, self.data)
        self.assertEqual(set(inp), {"utterance", "context", "choices"})
        for forbidden in ["expected", "expected_choice_id", "category", "application", "note", "split", "critical"]:
            self.assertNotIn(forbidden, inp)
        self.assertEqual(inp["context"]["now"], "2026-10-16T02:00:00Z")

    def test_correct_and_wrong_targets_are_distinct(self):
        c = next(c for c in self.data["cases"] if c["family"] == "delete-note")
        good = run.evaluate(c, {"choice_id": c["expected_choice_id"]}, 2)
        wrong = next(o for o in c["input"]["choices"] if o["decision"]["intent"] == "card.delete" and o["decision"] != c["expected"])
        bad = run.evaluate(c, {"choice_id": wrong["id"]}, 2)
        self.assertTrue(good["correct"])
        self.assertFalse(bad["target_correct"])
        self.assertTrue(bad["wrong_execution_choice"])

    def test_negation_wrong_execution_and_abstention_do_not_pass(self):
        negative = next(c for c in self.data["cases"] if c["family"] == "negation")
        harmful = next(o for o in negative["input"]["choices"] if o["decision"]["route"] == "local_action")
        self.assertTrue(run.evaluate(negative, {"choice_id": harmful["id"]})["wrong_execution_choice"])
        ask = next(o for o in self.case["input"]["choices"] if o["decision"]["route"] == "clarify")
        self.assertFalse(run.evaluate(self.case, {"choice_id": ask["id"]})["correct"])

    def test_format_probabilities_and_logits_are_validated(self):
        options = self.case["input"]["choices"]
        invalid = [{"choice_id": "C99"}, {"choice_id": self.case["expected_choice_id"], "confidence": .99},
                   {"probabilities": {o["id"]: 1 for o in options}},
                   {"probabilities": {o["id"]: float("nan") for o in options}}, {"probabilities": {}}]
        for value in invalid:
            with self.subTest(value=value):
                self.assertEqual(run.evaluate(self.case, value)["error"], "invalid_prediction")

    def test_threshold_coverage_and_precision(self):
        options = self.case["input"]["choices"]
        probs = {o["id"]: (.9 if o["id"] == self.case["expected_choice_id"] else .1/(len(options)-1)) for o in options}
        row = run.evaluate(self.case, {"probabilities": probs})
        self.assertTrue(row["simulated_accepted"])
        self.assertEqual(run.summarize([row])["simulated_precision"], 1)
        self.assertEqual(run.summarize([row])["simulated_coverage"], 1)
        choice_only = run.evaluate(self.case, {"choice_id": self.case["expected_choice_id"]})
        self.assertIsNone(run.summarize([choice_only])["simulated_precision"])
        tie = {o["id"]: 1/len(options) for o in options}
        self.assertFalse(run.evaluate(self.case, {"probabilities": tie})["simulated_accepted"])

    def test_missing_and_invalid_rows_stay_in_denominator(self):
        valid = run.evaluate(self.case, {"choice_id": self.case["expected_choice_id"]}, 20)
        missing = run.evaluate(self.case, None, error="missing_prediction")
        invalid = run.evaluate(self.case, {"choice_id": "bad"}, 100)
        summary = run.summarize([valid, missing, invalid])
        self.assertEqual(summary["samples"], 3)
        self.assertEqual(summary["errors"], 2)
        self.assertAlmostEqual(summary["exact_accuracy"], 1/3)
        self.assertEqual(summary["latency_success"]["p95_ms"], 20)
        self.assertEqual(summary["latency_all"]["p95_ms"], 100)

    def test_conditional_targets_and_family_split(self):
        families = {}
        for c in self.data["cases"]:
            families.setdefault(c["family"], set()).add(c["split"])
        self.assertTrue(all(len(s) == 1 for s in families.values()))
        confirms = [c for c in self.data["cases"] if c["input"]["utterance"] == "2号"]
        self.assertEqual({c["expected"]["intent"] for c in confirms}, {"card.delete", "note.expand", "clarify"})

    def test_http_adapter_and_chat_transport_with_fake_server(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append(body)
                value = {"choice_id": "C01"}
                if self.path == "/chat":
                    value = {"choices": [{"message": {"content": json.dumps(value)}, "finish_reason": "stop"}]}
                raw = json.dumps(value).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(raw)
            def log_message(self, *args): pass
        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            root = f"http://127.0.0.1:{server.server_port}"
            for protocol, path in [("chat", "/chat"), ("adapter", "/adapter")]:
                result = run.request_prediction(root+path, protocol, "fake", "system", {"utterance": "测试"}, 3, 128)
                self.assertEqual(result, {"choice_id": "C01"})
            self.assertEqual(received[0]["temperature"], 0)
            self.assertEqual(received[1]["input"], {"utterance": "测试"})
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_cli_import_and_csv_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            predictions = Path(tmp) / "predictions.jsonl"
            predictions.write_text("\n".join(json.dumps(dict(case_id=c["id"], choice_id=c["expected_choice_id"], roundtrip_ms=3)) for c in self.data["cases"]), encoding="utf-8")
            out = Path(tmp) / "result"
            result = subprocess.run([sys.executable, str(run.ROOT / "run.py"), "--split", "all", "--predictions", str(predictions), "--output", str(out)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((out / "report.json").read_text())
            self.assertEqual(report["summary"]["exact_accuracy"], 1)
            self.assertEqual(report["summary"]["samples"], len(self.data["cases"]))
            self.assertEqual(report["metadata"]["protocol"], "native-import")
            self.assertIsNone(report["metadata"]["temperature"])
            self.assertIsNone(report["metadata"]["max_tokens"])
            self.assertTrue((out / "results.csv").read_bytes().startswith(b"\xef\xbb\xbf"))


if __name__ == "__main__":
    unittest.main()
