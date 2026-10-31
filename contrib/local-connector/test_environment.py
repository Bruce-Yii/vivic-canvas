"""Real child-process tests for the deliberately restricted provider environment."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from connector import ConnectorState  # noqa: E402


NETWORK_PROVIDER = r'''
import json
import os
from pathlib import Path
import socket
import sys

required = json.loads(sys.argv[2])
report = {
    "missingEnvironment": [key for key, value in required.items() if os.environ.get(key) != value],
    "leakedSecrets": [key for key in ("OPENAI_API_KEY", "VIVIC_TEST_OAUTH_TOKEN") if key in os.environ],
    "socketOk": False,
}
try:
    # Exercise Windows network initialization, name resolution, and real TCP I/O.
    assert socket.getaddrinfo("localhost", 0, type=socket.SOCK_STREAM)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.settimeout(2)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        with socket.create_connection(listener.getsockname(), timeout=2) as client:
            with listener.accept()[0] as accepted:
                accepted.settimeout(2)
                client.sendall(b"provider-probe")
                assert accepted.recv(32) == b"provider-probe"
    report["socketOk"] = True
except Exception as exc:
    report["networkError"] = type(exc).__name__ + ": " + str(exc)
Path(sys.argv[1]).write_text(json.dumps(report), encoding="utf-8")
print(json.dumps({"event": "ready", "protocolVersion": "0.1"}), flush=True)
for line in sys.stdin:
    pass
'''


class ProviderEnvironmentTest(unittest.TestCase):
    def test_real_network_provider_starts_with_system_environment_but_no_secrets(self) -> None:
        names = ("SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA") if os.name == "nt" else ("PATH",)
        required = {name: os.environ[name] for name in names if name in os.environ}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            provider = root / "network_provider.py"
            provider.write_text(NETWORK_PROVIDER, encoding="utf-8")
            report_file = root / "network-report.json"
            state = ConnectorState(
                root / "data",
                provider_command=[sys.executable, str(provider), str(report_file), json.dumps(required)],
            )
            try:
                with patch.dict(os.environ, {"OPENAI_API_KEY": "sentinel-only", "VIVIC_TEST_OAUTH_TOKEN": "sentinel-only"}):
                    ok, _ = state.start()
                self.assertTrue(ok)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not report_file.exists():
                    time.sleep(0.02)
                self.assertTrue(report_file.exists(), "network provider did not write its startup report")
                report = json.loads(report_file.read_text(encoding="utf-8"))
                self.assertEqual(report["leakedSecrets"], [], "child inherited provider secrets")
                self.assertEqual(report["missingEnvironment"], [], f"required system environment was dropped: {report}")
                self.assertTrue(report["socketOk"], report.get("networkError", "network probe failed"))
            finally:
                state.stop()


if __name__ == "__main__":
    unittest.main()
