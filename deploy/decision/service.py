"""Independent resident StartLux 4B service. No ASR/TTS scheduling changes."""
import asyncio
import contextlib
import json
import logging
import os
import secrets
import socket
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import aiohttp
from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

ROOT = Path.home() / 'Library/Application Support/VivicModelAPI'
ENGINE = ROOT / 'runtime/startlux-engine'
MODEL = ROOT / 'models/startlux-4b-q8'
MODEL_ID = 'startlux-decision-4b'
TOKEN = (ROOT / 'worker-token').read_text().strip()
if not TOKEN:
    raise RuntimeError('Worker authentication is not configured')
sys.path.insert(0, str(ROOT / 'runtime/startlux-source'))
os.environ['STARTLUX_LLAMACPP_BIDIR'] = 'server'
from startlux_decide.backends.llamacpp import LlamaCppBackend
from startlux_decide.modelcfg import load_model_folder, load_tokenizer
from startlux_decide.pipeline import Decider, default_controls

logger = logging.getLogger('vivic.decision')


class NativeBody(BaseModel):
    state: dict[str, Any]
    questions: dict[str, dict[str, Any]] = Field(min_length=1, max_length=4)


class ResidentEngine:
    def __init__(self):
        self.process = None
        self.session = None
        self.backend = None
        self.decider = None
        self.controls = None
        self.ready = False
        self.generation = 0
        self.pending = 0
        self.lock = asyncio.Lock()
        self.model = load_model_folder(str(MODEL))
        self.tokenizer = load_tokenizer(str(MODEL))

    async def close(self):
        self.ready = False
        if self.backend:
            with contextlib.suppress(Exception):
                await self.backend.close()
            self.backend = None
        if self.session:
            await self.session.close()
            self.session = None
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                await asyncio.to_thread(self.process.wait, 10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                await asyncio.to_thread(self.process.wait, 5)
        self.process = None
        self.decider = None

    async def boot(self):
        await self.close()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        key = secrets.token_urlsafe(32)
        env = {**os.environ, 'LLAMA_API_KEY': key, 'DYLD_LIBRARY_PATH': str(ENGINE),
               'STARTLUX_LLAMACPP_BIDIR': 'server'}
        self.process = subprocess.Popen([
            str(ENGINE / 'llama-server'), '-m', str(MODEL / 'model.gguf'),
            '--host', '127.0.0.1', '--port', str(port), '--ctx-size', '4096',
            '--threads', '4', '--n-gpu-layers', '99', '--parallel', '1',
            '--ctx-checkpoints', '0', '-b', '4096', '-ub', '4096',
            '--no-webui', '--log-disable'], env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        url = 'http://127.0.0.1:' + str(port)
        self.session = aiohttp.ClientSession(
            headers={'Authorization': 'Bearer ' + key}, trust_env=False,
            timeout=aiohttp.ClientTimeout(total=20))
        loaded = False
        for _ in range(240):
            if self.process.poll() is not None:
                raise RuntimeError('Decision engine exited during startup')
            try:
                async with self.session.get(url + '/health', timeout=aiohttp.ClientTimeout(total=.5)) as response:
                    if response.status == 200:
                        loaded = True
                        break
            except (aiohttp.ClientError, asyncio.TimeoutError):
                pass
            await asyncio.sleep(.25)
        if not loaded:
            raise RuntimeError('Decision engine startup timeout')

        async def transport(route, body):
            kwargs = {} if body is None else {'json': body}
            async with self.session.request('GET' if body is None else 'POST', route, **kwargs) as response:
                response.raise_for_status()
                return json.loads(await response.read())

        self.backend = LlamaCppBackend(url, self.tokenizer, True, attempts=1, transport=transport)
        await self.backend.start()
        self.decider = Decider(self.model, self.backend,
                               default_controls(self.model, think_mode='never', allow_none=True),
                               context_length=4096, max_images=0)
        self.controls = self.decider.controls({'think_mode': 'never', 'allow_none': True, 'none_check': True})
        await self.decider.decide({'user_message': 'hello'}, {'route': {
            'type': 'choice', 'instructions': 'Choose the requested action.',
            'criteria': {'chat': 'A greeting or casual conversation',
                         'countdown': 'Create a countdown timer'}}}, self.controls)
        self.generation += 1
        self.ready = True

    async def watch(self):
        while True:
            await asyncio.sleep(.5)
            if self.process is None or self.process.poll() is not None:
                self.ready = False
                async with self.lock:
                    try:
                        await self.boot()
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:
                        logger.warning('Decision engine recovery failed: %s', type(error).__name__)
                        await self.close()
                        await asyncio.sleep(2)


manager = ResidentEngine()


@asynccontextmanager
async def lifespan(app):
    try:
        await manager.boot()
        watcher = asyncio.create_task(manager.watch())
        try:
            yield
        finally:
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher
    finally:
        await manager.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get('/health')
async def health():
    loaded = manager.ready and manager.process is not None and manager.process.poll() is None
    return {'ok': loaded, 'model': MODEL_ID, 'loaded': loaded, 'capacity': 1,
            'pending': manager.pending, 'generation': manager.generation,
            'engine_pid': manager.process.pid if manager.process else None}


@app.post('/v1/native')
async def native(body: NativeBody, request: Request, authorization: str = Header(default='')):
    supplied = authorization[7:] if authorization.lower().startswith('bearer ') else ''
    if not secrets.compare_digest(supplied, TOKEN):
        raise HTTPException(401, 'Invalid worker authentication')
    for question in body.questions.values():
        if question.get('type') not in ['choice', 'noul']:
            raise HTTPException(422, 'Only choice and noul questions are supported')
        if question['type'] == 'choice':
            criteria = question.get('criteria')
            if not isinstance(criteria, dict) or not 2 <= len(criteria) <= 64:
                raise HTTPException(422, 'Use 2-64 choice criteria')
    if not manager.ready:
        raise HTTPException(503, 'Decision engine is warming up')
    # No await occurs between checking and incrementing, on a single worker loop.
    if manager.pending >= 5:
        raise HTTPException(429, 'Decision queue is full')
    manager.pending += 1
    try:
        async with manager.lock:
            if not manager.ready:
                raise HTTPException(503, 'Decision engine is recovering')
            if await request.is_disconnected():
                raise HTTPException(499, 'Request cancelled')
            started = time.perf_counter()
            try:
                result = await asyncio.wait_for(
                    manager.decider.decide(body.state, body.questions, manager.controls), timeout=18)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.warning('Decision inference failed: %s', type(error).__name__)
                raise HTTPException(503, 'Decision inference unavailable') from None
            return {'answers': result.answers,
                    'latency_ms': round((time.perf_counter() - started) * 1000, 1)}
    finally:
        manager.pending -= 1
