"""StartLux native evaluation on Metal: same dataset/questions as run_eval.py, but with the canvas as state and
route/multi/target asked natively. Run with the VivicModelAPI venv-next python (has aiohttp + startlux_decide deps).

usage: python startlux_eval.py <name> <model-folder> [--cpu]
"""
import asyncio, json, os, secrets, socket, subprocess, sys, time, urllib.request
from pathlib import Path

LAB = Path(__file__).resolve().parent
sys.path.insert(0, str(LAB))
import run_eval as R

API = Path.home() / "Library/Application Support/VivicModelAPI"
sys.path.insert(0, str(API / "runtime/startlux-source"))
from startlux_decide.modelcfg import load_model_folder, load_tokenizer
from startlux_decide.backends.llamacpp import LlamaCppBackend
from startlux_decide.pipeline import Decider, default_controls
import aiohttp

ENGINE = API / "runtime/startlux-engine"


def start_engine(folder, gpu):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]
    key = secrets.token_urlsafe(24)
    env = {**os.environ, "LLAMA_API_KEY": key, "DYLD_LIBRARY_PATH": str(ENGINE), "STARTLUX_LLAMACPP_BIDIR": "server"}
    proc = subprocess.Popen([str(ENGINE / "llama-server"), "-m", str(Path(folder) / "model.gguf"), "--host", "127.0.0.1", "--port", str(port),
                             "--ctx-size", "4096", "--threads", "4", "--n-gpu-layers", "99" if gpu else "0", "--parallel", "1",
                             "--ctx-checkpoints", "0", "-b", "4096", "-ub", "4096", "--no-webui", "--log-disable"],
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(240):
        try:
            with urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/health", headers={"Authorization": "Bearer " + key}), timeout=.5) as r:
                if r.status == 200: break
        except Exception:
            if proc.poll() is not None: raise RuntimeError("engine exited")
            time.sleep(.25)
    os.environ["STARTLUX_LLAMACPP_BIDIR"] = "server"
    return proc, f"http://127.0.0.1:{port}", key


async def main():
    name, folder = sys.argv[1], sys.argv[2]
    gpu = "--cpu" not in sys.argv
    started = time.perf_counter()
    proc, url, key = start_engine(folder, gpu)
    mf, tok = load_model_folder(folder), load_tokenizer(folder)
    rows = []
    try:
        async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + key}, trust_env=False) as session:
            async def transport(route, body):
                async with session.request("GET" if body is None else "POST", route, **({} if body is None else {"json": body})) as resp:
                    resp.raise_for_status(); return json.loads(await resp.read())
            backend = LlamaCppBackend(url, tok, True, attempts=1, transport=transport); await backend.start()
            decider = Decider(mf, backend, default_controls(mf, think_mode="never", allow_none=True), context_length=4096, max_images=0)
            ctl = decider.controls({"think_mode": "never", "allow_none": True, "none_check": True})

            async def ask(text, qs):
                t = time.perf_counter()
                res = await decider.decide(R.kev_state(text), qs, ctl)
                return res.answers, (time.perf_counter() - t) * 1000

            route_q = {"type": "choice", "instructions": R.ROUTE_INSTR, "criteria": R.ROUTES}
            await ask("热身", {"route": route_q})
            load_s = time.perf_counter() - started
            for case in R.CASES:
                a, ms = await ask(case["text"], {"route": route_q})
                route = a["route"].get("choice"); probs = a["route"].get("probabilities") or {}
                qs = {"route": route_q, "multi": {"type": "noul", "instructions": R.MULTI_INSTR}}
                if case.get("target"): qs["target"] = {"type": "choice", "instructions": R.TARGET_INSTR, "criteria": R.TARGETS}
                b, full_ms = await ask(case["text"], qs)
                multi = b["multi"]; multi_p = multi.get("probability", multi.get("noul", 1.0 if multi.get("answer") else 0.0))
                p = probs.get(route) if route else None
                rows.append({"case": case, "route": route, "route_p": p, "route_ok": route == case["route"], "route_ms": round(ms, 1),
                             "full_ms": round(full_ms, 1), "target": b.get("target", {}).get("choice"), "multi_p": float(multi_p or 0)})
                print(f'{case["id"]:14} {str(route):11} {"OK " if route == case["route"] else "XX "} p={p} {ms:.0f}ms', flush=True)
            await backend.close()
    finally:
        proc.terminate(); proc.wait(30)
    result = {"model": name, "load_s": round(load_s, 1), "summary": R.summarize(rows), "rows": rows}
    (LAB / "results" / f"{name}.json").write_text(json.dumps(result, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in result["summary"].items() if k != "errors"}, ensure_ascii=False, indent=1))


asyncio.run(main())
