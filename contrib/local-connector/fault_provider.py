"""Subprocess fixtures for connector lifecycle fault tests; never a model."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["no-read", "startup-hang", "inference-hang", "array", "tree",
                                         "result-list", "unknown-action", "extra-field", "late-events"])
    parser.add_argument("--pids", required=True)
    args = parser.parse_args()
    pids = [os.getpid()]
    if args.mode == "tree":
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        pids.append(child.pid)
    Path(args.pids).write_text(json.dumps(pids), encoding="utf-8")
    if args.mode == "startup-hang":
        time.sleep(120)
        return
    print(json.dumps({"event": "ready", "protocolVersion": "0.1"}), flush=True)
    if args.mode in {"no-read", "tree"}:
        time.sleep(120)
        return
    for line in sys.stdin:
        message = json.loads(line)
        if message.get("op") != "decide":
            continue
        if args.mode == "array":
            print("[]", flush=True)
        elif args.mode in {"result-list", "unknown-action", "extra-field", "late-events"}:
            result = {"action": "fit", "source": "test-fixture"}
            if args.mode == "result-list":
                result = []
            elif args.mode == "unknown-action":
                result["action"] = "unsupported-fixture-action"
            elif args.mode == "extra-field":
                result["unexpected"] = True
            print(json.dumps({"event": "result", "runId": message["runId"], "result": result}), flush=True)
            if args.mode == "late-events":
                time.sleep(0.15)
                print(json.dumps({"event": "error", "runId": message["runId"],
                                  "code": "LATE_ERROR", "message": "late fixture error"}), flush=True)
                print(json.dumps({"event": "result", "runId": message["runId"],
                                  "result": {"action": "restore", "source": "test-fixture"}}), flush=True)
        else:
            time.sleep(120)


if __name__ == "__main__":
    main()
