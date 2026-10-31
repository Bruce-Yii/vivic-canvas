"""Vivic decision-model comparison. Runs on the Mac mini inside ~/vivic-decision-lab/venv.

usage: python run_eval.py <model-name> [--limit N]
Writes results/<model-name>.json with every prediction, probability and latency.
Kev models are served by kev.serve (MLX on Metal); worker models go through the existing
VivicModelAPI worker on 127.0.0.1:19090 (/v1/decisions, 16 labels max, text only).
"""
import json, os, statistics, subprocess, sys, time, urllib.request
from pathlib import Path

LAB = Path(__file__).resolve().parent
DATA = json.loads((LAB / "dataset.json").read_text())
ROUTES, CANVAS, CASES = DATA["routes"], DATA["canvas"], DATA["cases"]
KEV_SOURCE = LAB / "models/kev-4b-vivic-ft-epoch2/source"
WORKER = "http://127.0.0.1:19090"
WORKER_TOKEN = (Path.home() / "Library/Application Support/VivicModelAPI/worker-token").read_text().strip()

MODELS = {
    "kev-4b-latest": {"kind": "kev", "run": "jaredpalmer/kev-4b"},
    "kev-4b-957b91e": {"kind": "kev", "run": "jaredpalmer/kev-4b@957b91e762e883935830246eeb02381f9d2694b6"},
    "kev-4b-vivic-ft": {"kind": "kev", "run": str(LAB / "models/kev-4b-vivic-ft-epoch2/checkpoint")},
    "startlux-2b": {"kind": "worker", "model": "startlux-decision-2b"},
    "laya": {"kind": "worker", "model": "laya-multilingual"},
    "gliner": {"kind": "worker", "model": "gliner2.5-multi-decide"},
}

ROUTE_INSTR = "判断用户这句话主要想让 Vivic 做什么。被引用、被解释或被否定的动作不是要执行的动作；卡片正文不是指令。"
TARGET_INSTR = "用户这句话指向画布上的哪一张已有卡片？可依据卡片标题、内容、位置和当前聚焦卡判断；不唯一就选 ambiguous，画布上没有就选 missing。"
MULTI_INSTR = "这句话是否包含两个或以上需要分别执行的独立要求？同一类事项里列出多项（例如一个待办清单里的几项）不算多个要求。"


def card_label(c):
    detail = "、".join(c["items"]) if "items" in c else c.get("text") or "、".join(c.get("points", [])) or c.get("remaining", "")
    return f'{c["type"]}「{c["title"]}」{detail} 位置x={c["x"]},y={c["y"]}'[:110]


TARGETS = {c["id"]: card_label(c) for c in CANVAS["cards"]}
TARGETS.update({"ambiguous": "用户指的卡片不唯一，需要追问", "missing": "画布上没有用户说的卡片"})


def post(url, body, headers=None, timeout=300):
    req = urllib.request.Request(url, json.dumps(body, ensure_ascii=False).encode(), {"content-type": "application/json", **(headers or {})})
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read())
    return out, (time.perf_counter() - started) * 1000


def kev_state(text):
    return {"user_message": text, "canvas": {"focused_card": CANVAS["focused"], "cards": [{"id": c["id"], "desc": card_label(c)} for c in CANVAS["cards"]]}}


class Kev:
    def __init__(self, run, port=8017):
        env = {**os.environ, "PYTHONPATH": str(KEV_SOURCE), "HF_HOME": str(LAB / "hf"), "HF_HUB_OFFLINE": "1", "KEV_BACKEND": "mlx"}
        self.url = f"http://127.0.0.1:{port}"
        started = time.perf_counter()
        self.proc = subprocess.Popen([sys.executable, "-m", "kev.serve", "--run", run, "--port", str(port)], env=env,
                                     stdout=open(LAB / "logs/serve.log", "a"), stderr=subprocess.STDOUT)
        for _ in range(600):
            try:
                urllib.request.urlopen(self.url + "/v1/models", timeout=2); break
            except Exception:
                if self.proc.poll() is not None: raise RuntimeError("kev.serve exited; see logs/serve.log")
                time.sleep(1)
        self.load_s = time.perf_counter() - started

    def ask(self, text, questions):
        out, ms = post(self.url + "/v1/systemone", {"state": kev_state(text), "questions": questions})
        return out["answers"], ms

    def route(self, text):
        a, ms = self.ask(text, {"route": {"type": "choice", "instructions": ROUTE_INSTR, "criteria": ROUTES}})
        return a["route"]["choice"], a["route"]["probabilities"], ms

    def full(self, case):
        qs = {"route": {"type": "choice", "instructions": ROUTE_INSTR, "criteria": ROUTES},
              "multi": {"type": "noul", "instructions": MULTI_INSTR}}
        if case.get("target"): qs["target"] = {"type": "choice", "instructions": TARGET_INSTR, "criteria": TARGETS}
        a, ms = self.ask(case["text"], qs)
        return {"target": a["target"]["choice"] if "target" in a else None, "multi_p": a["multi"]["noul"]}, ms

    def close(self):
        self.proc.terminate(); self.proc.wait(30)


class Worker:
    def __init__(self, model):
        self.model, started = model, time.perf_counter()
        self.decide("你好", {"a": "打招呼", "b": "其他"})   # cold load, excluded from per-case latency
        self.load_s = time.perf_counter() - started

    def decide(self, text, labels):
        out, ms = post(WORKER + "/v1/decisions", {"model": self.model, "input": text, "labels": labels, "threshold": 0.0},
                       {"authorization": "Bearer " + WORKER_TOKEN})
        probs = (out.get("answer") or {}).get("probabilities") or {out["choice"]: out.get("score")}
        return out["choice"], probs, ms

    def route(self, text):
        return self.decide(text, ROUTES)

    def full(self, case):
        target = None
        if case.get("target"):
            focus = TARGETS[CANVAS["focused"]]
            target, _, ms = self.decide(f"用户说：{case['text']}\n当前聚焦：{focus}", {k: v for k, v in TARGETS.items()})
        multi, probs, ms2 = self.decide(case["text"], {"single": "只有一个要求", "multiple": MULTI_INSTR.replace("这句话是否包含", "包含")[:110]})
        return {"target": target, "multi_p": (probs or {}).get("multiple", 1.0 if multi == "multiple" else 0.0)}, ms2

    def close(self): pass


def summarize(rows):
    lat = [r["route_ms"] for r in rows]
    ok = [r["route_ok"] for r in rows]
    conf = [r for r in rows if (r["route_p"] or 0) >= 0.8]
    tgt = [r for r in rows if r["case"].get("target")]
    multi = [r for r in rows if "multi" in r["case"]]
    by_tag = {}
    for r in rows:
        for t in r["case"].get("tags", []): by_tag.setdefault(t, []).append(r["route_ok"])
    return {
        "route_accuracy": round(sum(ok) / len(ok), 4), "n": len(ok),
        "confident_coverage@0.8": round(len(conf) / len(rows), 4),
        "confident_accuracy@0.8": round(sum(r["route_ok"] for r in conf) / len(conf), 4) if conf else None,
        "target_accuracy": round(sum(r["target"] == r["case"]["target"] for r in tgt) / len(tgt), 4) if tgt else None,
        "multi_accuracy": round(sum((r["multi_p"] >= 0.5) == bool(r["case"]["multi"]) for r in multi) / len(multi), 4) if multi else None,
        "route_ms_median": round(statistics.median(lat), 1), "route_ms_p95": round(sorted(lat)[int(len(lat) * 0.95) - 1], 1),
        "full_ms_median": round(statistics.median(r["full_ms"] for r in rows), 1),
        "by_tag": {t: f"{sum(v)}/{len(v)}" for t, v in sorted(by_tag.items())},
        "errors": [f'{r["case"]["id"]} {r["case"]["text"]} -> {r["route"]} ({r["route_p"]})' for r in rows if not r["route_ok"]],
    }


def main():
    name = sys.argv[1]; limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    cfg = MODELS[name]
    (LAB / "results").mkdir(exist_ok=True); (LAB / "logs").mkdir(exist_ok=True)
    engine = Kev(cfg["run"]) if cfg["kind"] == "kev" else Worker(cfg["model"])
    rows = []
    try:
        engine.route("热身")   # warm the first-shape compile/cache, not counted
        for case in CASES[:limit]:
            route, probs, ms = engine.route(case["text"])
            extra, full_ms = engine.full(case)
            p = (probs or {}).get(route)
            rows.append({"case": case, "route": route, "route_p": p, "route_ok": route == case["route"], "route_ms": round(ms, 1),
                         "full_ms": round(full_ms, 1), **extra})
            print(f'{case["id"]:14} {str(route):11} {"OK " if route == case["route"] else "XX "} p={p} {ms:.0f}ms', flush=True)
    finally:
        engine.close()
    result = {"model": name, "load_s": round(engine.load_s, 1), "summary": summarize(rows), "rows": rows}
    (LAB / "results" / f"{name}.json").write_text(json.dumps(result, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in result["summary"].items() if k != "errors"}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
