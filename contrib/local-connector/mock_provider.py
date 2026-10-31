#!/usr/bin/env python3
"""Deterministic local decision service used by the RUN-01 smoke test.

It is a real child process speaking the same JSONL protocol as an eventual
model adapter.  It intentionally performs no network access and reads no
credentials, so it is safe to run in CI and on a user's machine.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading


def choose_action(text: str) -> str:
    if any(word in text for word in ("全部", "所有", "全景", "一屏")):
        return "fit"
    if any(word in text for word in ("恢复", "返回", "还原")):
        return "restore"
    if any(word in text for word in ("展开", "全文", "更多")):
        return "expand"
    if any(word in text for word in ("收起", "概要", "紧凑")):
        return "collapse"
    return "other"


def main(delay: float) -> int:
    print(json.dumps({"event": "ready", "protocolVersion": "0.1"}), flush=True)
    pending: dict[str, threading.Event] = {}
    lock = threading.Lock()

    def decide(run_id: str, text: str, canceled: threading.Event) -> None:
        # Read cancel messages on the main thread while this fixture waits.
        # Real model adapters must implement their own cooperative cancellation.
        if not canceled.wait(delay):
            with lock:
                if not canceled.is_set():
                    print(json.dumps({"event": "result", "runId": run_id,
                                      "result": {"action": choose_action(text), "source": "local-fixture"}},
                                     ensure_ascii=False), flush=True)
        with lock:
            pending.pop(run_id, None)

    for line in sys.stdin:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"event": "error", "code": "INVALID_JSON", "message": "invalid provider request"}), flush=True)
            continue
        if not isinstance(message, dict):
            continue
        op = message.get("op")
        run_id = message.get("runId")
        if op == "cancel" and isinstance(run_id, str):
            with lock:
                event = pending.get(run_id)
                if event is not None:
                    event.set()
            continue
        if op != "decide" or not isinstance(run_id, str) or not isinstance(message.get("text"), str):
            print(json.dumps({"event": "error", "runId": run_id, "code": "INVALID_REQUEST", "message": "invalid decision request"}), flush=True)
            continue
        canceled = threading.Event()
        with lock:
            pending[run_id] = canceled
        threading.Thread(target=decide, args=(run_id, message["text"], canceled), daemon=True).start()
    with lock:
        for event in pending.values():
            event.set()
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--delay", type=float, default=0.02)
    raise SystemExit(main(max(0.0, min(parser.parse_args().delay, 5.0))))
