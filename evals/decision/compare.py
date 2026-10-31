"""Summarize results/*.json into one comparison table (markdown on stdout)."""
import json, sys
from pathlib import Path

LAB = Path(__file__).resolve().parent
GROUP = {"answer": "llm", "generate": "llm", "search": "search", "chat": "chat", "countdown": "create", "todo": "create", "note": "create",
         "focus": "card", "overview": "view", "restore": "view", "highlight": "card", "edit": "card", "arrange": "card",
         "undo": "card", "delete": "delete", "unsupported": "unsupported"}
GATE = 0.8

print("| 模型 | 路由准确率 | 执行者准确率 | 高置信覆盖 | 高置信准确率 | 目标卡准确率 | 多意图 | 高置信误删 | 中位延迟 | 冷启动 |")
print("|---|---|---|---|---|---|---|---|---|---|")
for f in sorted((LAB / "results").glob("*.json")):
    r = json.loads(f.read_text()); s = r["summary"]; rows = r["rows"]
    coarse = sum(GROUP.get(x["route"]) == GROUP[x["case"]["route"]] for x in rows) / len(rows)
    bad_delete = sum(x["route"] == "delete" and x["case"]["route"] != "delete" and (x["route_p"] or 0) >= GATE for x in rows)
    pct = lambda v: "-" if v is None else f"{v * 100:.1f}%"
    print(f'| {r["model"]} | {pct(s["route_accuracy"])} | {pct(coarse)} | {pct(s["confident_coverage@0.8"])} | {pct(s["confident_accuracy@0.8"])} '
          f'| {pct(s["target_accuracy"])} | {pct(s["multi_accuracy"])} | {bad_delete} | {s["route_ms_median"] / 1000:.2f}s | {r["load_s"]}s |')
