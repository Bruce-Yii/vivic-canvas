"""Private JSONL adapter; official StartLux owns prompt, bidirectional readout and calibration.
No HTTP listener, model commands, user files, microphone, playback or content logging.
"""
import asyncio
import json
import os
import sys

import aiohttp
from startlux_decide.modelcfg import load_model_folder, load_tokenizer
from startlux_decide.backends.llamacpp import LlamaCppBackend
from startlux_decide.pipeline import Decider, default_controls


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


async def main():
    config = json.loads(sys.stdin.buffer.readline(16385))
    folder = load_model_folder(config["model"])
    if not folder.bidirectional:
        raise RuntimeError("Instant model metadata required")
    tokenizer = load_tokenizer(config["model"])
    async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + config["key"]},
                                     timeout=aiohttp.ClientTimeout(total=20), trust_env=False) as session:
        async def transport(route, body):
            async with session.request("GET" if body is None else "POST", route,
                                       **({} if body is None else {"json": body}), allow_redirects=False) as response:
                response.raise_for_status()
                raw = await response.content.read(65537)
                if len(raw) > 65536:
                    raise RuntimeError("engine response limit")
                return json.loads(raw)
        backend = LlamaCppBackend(config["url"], tokenizer, True, attempts=1, transport=transport)
        await backend.start()
        context_length = config.get("contextLength", 2048)
        if context_length not in (2048, 8192):
            raise RuntimeError("unsupported context length")
        decider = Decider(folder, backend, default_controls(folder, think_mode="never", allow_none=True),
                          context_length=context_length, max_images=0)
        emit({"ready": True, "engine": {"bidir_mode": backend.bidir_mode, "prompt_attention": folder.prompt_attention}})
        try:
            while True:
                line = await asyncio.to_thread(sys.stdin.buffer.readline, 131073)
                if not line:
                    break
                if len(line) > 131072:
                    raise RuntimeError("request limit")
                message = json.loads(line)
                request = message["payload"]
                try:
                    decision = await decider.decide(request["state"], request["questions"], decider.controls(request))
                    emit({"id": message["id"], "result": {"answers": decision.answers}})
                except Exception as error:
                    # Exception class only: no URL, headers, model text or exception message.
                    emit({"id": message["id"], "error": "decision_failed", "errorType": type(error).__name__})
        finally:
            await backend.close()


if __name__ == "__main__":
    # The only environment selector used by the official backend; never accept a causal fallback.
    os.environ["STARTLUX_LLAMACPP_BIDIR"] = "server"
    asyncio.run(main())
