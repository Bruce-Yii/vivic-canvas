"""Live Mac acceptance: latency, authentication, bounded queue and recovery. No audio playback."""
import asyncio
import json
import os
import signal
import statistics
import subprocess
import sys
import time
from pathlib import Path

import aiohttp

ROOT = Path.home() / 'Library/Application Support/VivicModelAPI'
LAB = Path.home() / 'vivic-decision-lab'
sys.path.insert(0, str(LAB))
import run_eval as evaluation

BASE = 'http://127.0.0.1:19095'
HEADERS = {'Authorization': 'Bearer ' + (ROOT / 'worker-token').read_text().strip(),
           'X-Vivic-Owner': 'decision-acceptance'}
QUESTION = {'route': {'type': 'choice', 'instructions': evaluation.ROUTE_INSTR,
                       'criteria': evaluation.ROUTES}}


async def ask(session, case):
    started = time.perf_counter()
    async with session.post(BASE + '/v1/native', json={
            'state': evaluation.kev_state(case['text']), 'questions': QUESTION}) as response:
        result = await response.json()
        if response.status != 200:
            return {'status': response.status}
    answer = result['answers']['route']
    return {'status': 200, 'case': case.get('id'), 'expected': case.get('route'),
            'route': answer.get('choice'), 'server_ms': result['latency_ms'],
            'roundtrip_ms': round((time.perf_counter() - started) * 1000, 1)}


async def health(session):
    async with session.get(BASE + '/health') as response:
        return await response.json()


async def wait_ready(session, predicate):
    for _ in range(120):
        try:
            value = await health(session)
            if value.get('loaded') and predicate(value): return value
        except (aiohttp.ClientError, asyncio.TimeoutError): pass
        await asyncio.sleep(.5)
    raise RuntimeError('Decision service did not recover')


async def main():
    report = {}
    async with aiohttp.ClientSession(headers=HEADERS, trust_env=False,
                                    timeout=aiohttp.ClientTimeout(total=120)) as session:
        report['initial_health'] = await health(session)
        cases = evaluation.CASES[:10]
        rows = [await ask(session, case) for case in cases]
        report['warm'] = rows
        report['warm_median_ms'] = statistics.median(x['roundtrip_ms'] for x in rows)
        print(json.dumps({'warm_median_ms': report['warm_median_ms'],
                          'correct': sum(x.get('route') == x.get('expected') for x in rows),
                          'cases': len(rows)}), flush=True)
        async with aiohttp.ClientSession(trust_env=False) as anonymous:
            async with anonymous.post(BASE + '/v1/native', json={
                    'state': {'user_message': 'hello'}, 'questions': QUESTION}) as response:
                report['unauthenticated_status'] = response.status
        simultaneous = await asyncio.gather(*(ask(session, cases[0]) for _ in range(6)))
        report['queue_statuses'] = [x['status'] for x in simultaneous]

        # The PID/generation must remain unchanged while the legacy worker loads TTS.
        before = await health(session)

        async def tts():
            async with session.post('http://127.0.0.1:19090/v1/audio/speech', json={
                    'model': 'qwen3-tts-1.7b', 'input': '\u6d4b\u8bd5',
                    'voice': 'Vivian', 'language': 'Chinese', 'response_format': 'wav'}) as response:
                data = await response.read()
                report['tts'] = {'status': response.status, 'bytes': len(data),
                                 'content_type': response.headers.get('content-type')}
                if response.status == 200:
                    audio = ROOT / 'decision-service/acceptance-tts.wav'
                    audio.write_bytes(data)
                    audio.chmod(0o600)
        task = asyncio.create_task(tts())
        await asyncio.sleep(.25)
        report['during_tts'] = [await ask(session, cases[i]) for i in range(3)]
        await task
        report['after_tts'] = [await ask(session, cases[i]) for i in range(3)]
        after = await health(session)
        report['not_evicted_by_tts'] = (before['engine_pid'] == after['engine_pid']
                                      and before['generation'] == after['generation'])
        report['during_tts_median_ms'] = statistics.median(x['roundtrip_ms'] for x in report['during_tts'])
        report['after_tts_median_ms'] = statistics.median(x['roundtrip_ms'] for x in report['after_tts'])
        print(json.dumps({k: report[k] for k in ['tts', 'not_evicted_by_tts',
                          'during_tts_median_ms', 'after_tts_median_ms']}), flush=True)

        os.kill(after['engine_pid'], signal.SIGTERM)
        recovered = await wait_ready(session, lambda h: h['generation'] > after['generation'])
        report['engine_recovery'] = recovered
        old_pid = recovered['engine_pid']
        subprocess.check_call(['launchctl', 'kickstart', '-k', 'gui/' + str(os.getuid()) + '/com.vivic.decision'])
        report['launchd_recovery'] = await wait_ready(session, lambda h: h['engine_pid'] != old_pid)
        report['old_engine_alive'] = subprocess.run(['kill', '-0', str(old_pid)],
                                                   stderr=subprocess.DEVNULL).returncode == 0
        report['final_probe'] = await ask(session, cases[0])
    passed = (report['warm_median_ms'] < 2200 and report['unauthenticated_status'] == 401
              and 429 in report['queue_statuses'] and report['not_evicted_by_tts']
              and report['tts']['status'] == 200 and report['final_probe']['status'] == 200
              and not report['old_engine_alive'])
    report['passed'] = passed
    out = ROOT / 'decision-service/acceptance-B1.json'
    out.write_text(json.dumps(report, ensure_ascii=True, indent=2) + '\n')
    out.chmod(0o600)
    print(json.dumps({'passed': passed, 'report': str(out),
                      'queue_statuses': report['queue_statuses'],
                      'engine_recovered': True, 'launchd_recovered': True,
                      'old_engine_alive': report['old_engine_alive']}), flush=True)
    if not passed: raise SystemExit(1)


asyncio.run(main())
