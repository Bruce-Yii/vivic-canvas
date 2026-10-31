"""Python 3.9+ stdlib runner. Never imports Vivic or executes predicted actions."""
import argparse
import collections
import csv
import hashlib
import json
import math
import os
import platform
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION = "vivic-decision-benchmark-1"


def read_data():
    raw = (ROOT / "dataset.json").read_bytes()
    data = json.loads(raw)
    assert data["schema_version"] == VERSION, "unsupported dataset version"
    assert len({c["id"] for c in data["cases"]}) == len(data["cases"]), "duplicate case IDs"
    family_splits = collections.defaultdict(set)
    for c in data["cases"]:
        assert c["input"]["context_id"] in data["contexts"], c["id"]
        options = c["input"]["choices"]
        assert len({o["id"] for o in options}) == len(options), c["id"]
        assert len({json.dumps(o["decision"], sort_keys=True) for o in options}) == len(options), c["id"]
        expected = [o for o in options if o["id"] == c["expected_choice_id"]]
        assert len(expected) == 1 and expected[0]["decision"] == c["expected"], c["id"]
        ctx = data["contexts"][c["input"]["context_id"]]
        known = {x["id"] for x in ctx["cards"] + ctx["canvases"]}
        assert all(t in known for t in c["expected"]["target_ids"]), c["id"]
        family_splits[c["family"]].add(c["split"])
    assert all(len(v) == 1 for v in family_splits.values()), "family leaked across splits"
    return data, hashlib.sha256(raw).hexdigest()


def model_input(case, data):
    # Gold, family/category/application/split/note are deliberately never sent.
    return dict(utterance=case["input"]["utterance"],
                context=data["contexts"][case["input"]["context_id"]], choices=case["input"]["choices"])


def parse_prediction(value, choices):
    if not isinstance(value, dict) or set(value) - {"choice_id", "probabilities"}:
        raise ValueError("response must contain only choice_id and/or probabilities")
    ids = [o["id"] for o in choices]
    choice = value.get("choice_id")
    probs = value.get("probabilities")
    top_p = margin = None
    if probs is not None:
        if not isinstance(probs, dict) or set(probs) != set(ids):
            raise ValueError("probabilities must cover every candidate ID exactly")
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 or v > 1 for v in probs.values()):
            raise ValueError("probabilities must be finite numbers in [0,1]")
        if abs(sum(probs.values()) - 1) > 0.0001:
            raise ValueError("probabilities must sum to 1; logits are not probabilities")
        ranked = sorted(ids, key=lambda i: probs[i], reverse=True)
        winner = ranked[0]
        if choice is not None and choice != winner:
            raise ValueError("choice_id disagrees with top probability")
        choice = winner
        top_p, margin = probs[winner], probs[winner] - probs[ranked[1]]
    if not isinstance(choice, str) or choice not in ids:
        raise ValueError("unknown or missing choice_id")
    return choice, top_p, margin


def request_prediction(url, protocol, model, system, inp, timeout, max_tokens):
    if protocol == "chat":
        payload = dict(model=model, temperature=0, max_tokens=max_tokens, stream=False,
            messages=[dict(role="system", content=system), dict(role="user", content=json.dumps(inp, ensure_ascii=False))])
    else:
        payload = dict(schema_version=VERSION, system=system, input=inp)
    headers = {"Content-Type": "application/json"}
    key = os.environ.get("BENCHMARK_API_KEY")
    if key:
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(url, json.dumps(payload, ensure_ascii=False).encode(), headers)
    # Do not print URLs, credentials, server bodies or exception messages to logs.
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("response exceeds 2MB")
        result = json.loads(raw)
    if protocol == "chat":
        item = result["choices"][0]
        if item.get("finish_reason") not in (None, "stop"):
            raise ValueError("chat response did not finish normally")
        result = json.loads(item["message"]["content"])
    return result


def evaluate(case, prediction, ms=None, threshold=.8, min_margin=.25, error=None):
    predicted = None
    choice = None
    top_p = margin = None
    if error is None:
        try:
            choice, top_p, margin = parse_prediction(prediction, case["input"]["choices"])
            predicted = next(o["decision"] for o in case["input"]["choices"] if o["id"] == choice)
        except (ValueError, TypeError, KeyError):
            error = "invalid_prediction"
    expected = case["expected"]
    correct = bool(predicted is not None and predicted == expected)
    route_correct = bool(predicted is not None and predicted["route"] == expected["route"])
    target_correct = bool(predicted is not None and predicted["target_ids"] == expected["target_ids"])
    # Raw wrong executable/tool choices, including wrong target/slots and partially executed compounds.
    wrong_execution = bool(predicted and predicted["route"] in ("local_action", "tool") and not correct)
    executable = bool(predicted and predicted["route"] in ("local_action", "tool"))
    gate = None if top_p is None else bool(executable and top_p >= threshold and margin >= min_margin)
    return dict(case_id=case["id"], family=case["family"], category=case["category"], application=case["application"],
        split=case["split"], critical=case["critical"], expected_choice_id=case["expected_choice_id"], choice_id=choice,
        correct=correct, route_correct=route_correct, target_correct=target_correct,
        wrong_execution_choice=wrong_execution, predicted=predicted, expected=expected,
        top_probability=top_p, probability_margin=margin, simulated_accepted=gate,
        roundtrip_ms=ms, error=error)


def rate(a, b): return a / b if b else None


def percentiles(values):
    ordered = sorted(values)
    return {f"p{p}_ms": ordered[max(0, math.ceil(len(ordered) * p / 100) - 1)] if ordered else None for p in (50, 95, 99)}


def summarize(rows):
    scored = [r for r in rows if r["error"] is None]
    critical = [r for r in rows if r["critical"]]
    accepted = [r for r in rows if r["simulated_accepted"] is True]
    with_probs = [r for r in rows if r["top_probability"] is not None]
    eligible = [r for r in rows if r["expected"]["route"] in ("local_action", "tool")]
    # Target accuracy is conditional on an expected target; no-target cases do not inflate it.
    targets = [r for r in rows if r["expected"]["target_ids"]]
    return dict(samples=len(rows), valid_predictions=len(scored), errors=len(rows)-len(scored),
        exact_accuracy=rate(sum(r["correct"] for r in rows), len(rows)),
        route_accuracy=rate(sum(r["route_correct"] for r in rows), len(rows)),
        target_accuracy=rate(sum(r["target_correct"] for r in targets), len(targets)), target_samples=len(targets),
        wrong_execution_choices=sum(r["wrong_execution_choice"] for r in rows),
        critical_samples=len(critical), critical_accuracy=rate(sum(r["correct"] for r in critical), len(critical)),
        probability_samples=len(with_probs), simulated_accepted=len(accepted) if with_probs else None,
        simulated_precision=rate(sum(r["correct"] for r in accepted), len(accepted)),
        simulated_wrong_execution_choices=sum(not r["correct"] for r in accepted) if with_probs else None,
        simulated_coverage=rate(len(accepted), len(rows)) if with_probs else None,
        eligible_samples=len(eligible), eligible_exact_accuracy=rate(sum(r["correct"] for r in eligible), len(eligible)),
        latency_samples=sum(r["roundtrip_ms"] is not None for r in rows),
        latency_success_samples=sum(r["roundtrip_ms"] is not None for r in scored),
        latency_success=percentiles([r["roundtrip_ms"] for r in scored if r["roundtrip_ms"] is not None]),
        latency_all=percentiles([r["roundtrip_ms"] for r in rows if r["roundtrip_ms"] is not None]))


def write_reports(output, rows, metadata):
    output.mkdir(parents=True, exist_ok=True)
    report = dict(metadata=metadata, summary=summarize(rows), by_category={}, by_application={}, by_split={},
                  confusion_route={}, rows=rows)
    for field, target in [("category", "by_category"), ("application", "by_application"), ("split", "by_split")]:
        for key in sorted({r[field] for r in rows}):
            report[target][key] = summarize([r for r in rows if r[field] == key])
    for r in rows:
        key = r["expected"]["route"] + " -> " + (r["predicted"]["route"] if r["predicted"] else "ERROR")
        report["confusion_route"][key] = report["confusion_route"].get(key, 0) + 1
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    fields = ["case_id", "repeat", "category", "application", "split", "critical", "expected_choice_id", "choice_id", "correct", "route_correct", "target_correct", "wrong_execution_choice", "roundtrip_ms", "top_probability", "probability_margin", "simulated_accepted", "error"]
    with (output / "results.csv").open("w", encoding="utf-8-sig", newline="") as out:
        writer = csv.DictWriter(out, fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-data", action="store_true")
    parser.add_argument("--export-inputs", type=Path)
    parser.add_argument("--predictions", type=Path, help="import JSONL from a native model adapter")
    parser.add_argument("--url", help="exact POST URL; no path is appended")
    parser.add_argument("--protocol", choices=["chat", "adapter"], default="chat")
    parser.add_argument("--model", default="local-model", help="use the actual served model ID")
    parser.add_argument("--split", choices=["all", "dev", "holdout"], default="dev")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--seed", type=int, default=20261016)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--max-tokens", type=int, default=128)
    parser.add_argument("--threshold", type=float, default=.8)
    parser.add_argument("--margin", type=float, default=.25)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--machine-label", default="unspecified", help="CPU/GPU/RAM/quantization label; no secrets")
    args = parser.parse_args()
    if args.repeat < 1 or args.limit < 0 or args.warmup < 0 or args.timeout <= 0 or args.max_tokens < 1:
        parser.error("repeat/max-tokens/timeout must be positive; limit/warmup nonnegative")
    if not 0 <= args.threshold <= 1 or not 0 <= args.margin <= 1:
        parser.error("threshold/margin must be in [0,1]")
    if args.url and args.predictions:
        parser.error("choose either --url or --predictions")
    data, digest = read_data()
    cases = [c for c in data["cases"] if args.split == "all" or c["split"] == args.split]
    random.Random(args.seed).shuffle(cases)
    if args.limit:
        cases = cases[:args.limit]
    if args.check_data:
        print(json.dumps(dict(dataset_sha256=digest, total=len(data["cases"]), selected=len(cases)), ensure_ascii=False))
        return 0
    system = (ROOT / "system-prompt.md").read_text(encoding="utf-8")
    tasks = [(c, repeat) for repeat in range(1, args.repeat + 1) for c in cases]
    if args.export_inputs:
        args.export_inputs.parent.mkdir(parents=True, exist_ok=True)
        with args.export_inputs.open("w", encoding="utf-8") as out:
            for c, repeat in tasks:
                out.write(json.dumps(dict(case_id=c["id"], repeat=repeat, system=system, input=model_input(c, data)), ensure_ascii=False) + "\n")
        print(f"Exported {len(tasks)} inputs (no answers): {args.export_inputs}")
        return 0
    if not args.url and not args.predictions:
        parser.error("provide --url, --predictions, --export-inputs or --check-data")
    if args.url and not args.url.startswith(("http://", "https://")):
        parser.error("URL must start with http:// or https://")
    output = args.output or ROOT / "results" / time.strftime("%Y%m%d-%H%M%S")
    if output.exists() and any(output.iterdir()):
        parser.error("output directory is not empty; choose a fresh directory to preserve results")
    supplied = {}
    if args.predictions:
        selected = {(c["id"], repeat) for c, repeat in tasks}
        for line in args.predictions.read_text(encoding="utf-8-sig").splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            key = (item["case_id"], item.get("repeat", 1))
            if key not in selected or key in supplied:
                parser.error("predictions contain duplicate or unselected case/repeat IDs")
            ms = item.get("roundtrip_ms")
            if ms is not None and (isinstance(ms, bool) or not isinstance(ms, (int, float)) or not math.isfinite(ms) or ms < 0):
                parser.error("roundtrip_ms must be a nonnegative finite number")
            supplied[key] = item
    warmup_times = []
    rows = []
    if args.url:
        for _ in range(args.warmup):
            before = time.perf_counter()
            try:
                warm_prediction = request_prediction(args.url, args.protocol, args.model, system, model_input(cases[0], data), args.timeout, args.max_tokens)
                parse_prediction(warm_prediction, cases[0]["input"]["choices"])
            except Exception as exc:
                print(f"Warmup failed ({type(exc).__name__}); check endpoint/protocol/model. No credentials or server body printed.", file=sys.stderr)
                return 2
            warmup_times.append((time.perf_counter() - before) * 1000)
    for index, (case, repeat) in enumerate(tasks):
        prediction, ms, error = None, None, None
        if args.predictions:
            item = supplied.get((case["id"], repeat))
            if item is None:
                error = "missing_prediction"
            else:
                prediction = {k: item[k] for k in ("choice_id", "probabilities") if k in item}
                ms = item.get("roundtrip_ms")
        else:
            before = time.perf_counter()
            try:
                prediction = request_prediction(args.url, args.protocol, args.model, system, model_input(case, data), args.timeout, args.max_tokens)
            except Exception as exc:
                error = "request_" + type(exc).__name__
            ms = (time.perf_counter() - before) * 1000
        row = evaluate(case, prediction, ms, args.threshold, args.margin, error)
        row["repeat"] = repeat
        rows.append(row)
        if (index + 1) % 10 == 0 or index + 1 == len(tasks):
            print(f"{index + 1}/{len(tasks)} scored; errors={sum(r['error'] is not None for r in rows)}", flush=True)
    metadata = dict(schema_version=VERSION, dataset_sha256=digest, model=args.model, protocol="native-import" if args.predictions else args.protocol,
        mode="import" if args.predictions else "http", machine_label=args.machine_label,
        host_platform=platform.system(), python=platform.python_version(), seed=args.seed,
        split=args.split, repeat=args.repeat, unique_cases=len(cases), threshold=args.threshold, margin=args.margin,
        warmup_roundtrip_ms=warmup_times, system_prompt_sha256=hashlib.sha256(system.encode()).hexdigest(),
        temperature=0 if args.url and args.protocol == "chat" else None,
        max_tokens=args.max_tokens if args.url and args.protocol == "chat" else None,
        note="Synthetic closed-choice benchmark. No canvas/actions executed. HTTP time includes transport and queueing. Warmup is not model-load time. Probability gating is an offline simulation, not production acceptance.")
    report = write_reports(output, rows, metadata)
    print(json.dumps(dict(output=str(output), summary=report["summary"]), ensure_ascii=False, indent=2))
    return 2 if any(r["error"] for r in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
