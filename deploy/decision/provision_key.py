"""Run on server. Administrator password arrives on stdin, never via argv/logs."""
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from http.cookies import SimpleCookie
from pathlib import Path

password = json.load(sys.stdin)['password']
configuration = json.loads(Path('/etc/vivic-model-api/config.json').read_text())
origin = configuration['origin'].rstrip('/')
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
headers = {'Origin': origin, 'X-Vivic-Console': '1', 'Content-Type': 'application/json'}


def console(route, method='GET', value=None):
    request = urllib.request.Request('http://127.0.0.1:8796/api/console' + route,
        data=json.dumps(value).encode() if value is not None else None,
        headers=headers, method=method)
    with opener.open(request, timeout=15) as response:
        result = json.load(response)
        if response.headers.get('Set-Cookie'):
            cookie = SimpleCookie();cookie.load(response.headers['Set-Cookie'])
            headers['Cookie'] = '; '.join(k + '=' + v.value for k, v in cookie.items())
        return result


console('/login', 'POST', {'password': password})
del password
try:
    keys = console('/keys')['keys']
    existing = [k for k in keys if k['name'] == 'vivic-backend-decision' and not k['revoked']]
    assert len(existing) <= 1, 'Duplicate backend decision keys require review'
    if existing:
        entry = existing[0]
        assert entry['permissions'] == ['decisions'] and not entry['paused'], 'Existing key has unexpected permissions'
        token = console('/keys/' + entry['id'] + '/reveal', 'POST', {})['key']
    else:
        entry = console('/keys', 'POST', {'name': 'vivic-backend-decision', 'permissions': ['decisions']})
        if entry['permissions'] != ['decisions']:
            console('/keys/' + entry['id'], 'DELETE')
            raise RuntimeError('Dedicated key permission validation failed')
        token = entry['key']
    env_path = Path('/opt/vivic-preview-20261025/backend/env.list')
    original = env_path.read_text()
    updates = {'VIVIC_DECISION_API_KEY': token, 'VIVIC_DECISION_URL': origin + '/api/v1/decisions',
               'VIVIC_DECISION_MODEL': 'startlux-decision-4b'}
    lines = [l for l in original.splitlines() if l.split('=', 1)[0] not in updates]
    lines += [k + '=' + v for k, v in updates.items()]
    shutil.copy2(env_path, str(env_path) + '.bak-' + time.strftime('%Y%m%dT%H%M%S'))
    temporary = env_path.with_suffix('.tmp')
    temporary.write_text('\n'.join(lines) + '\n')
    temporary.chmod(0o600)
    temporary.replace(env_path)

    def api(route, value=None):
        request = urllib.request.Request(origin + '/api' + route,
            data=json.dumps(value, ensure_ascii=False).encode() if value is not None else None,
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        started = time.perf_counter()
        with opener.open(request, timeout=25) as response:
            return response.status, json.load(response), round((time.perf_counter() - started) * 1000, 1)

    status, native, latency = api('/v1/decisions', {
        'model': 'startlux-decision-4b', 'state': {'user_message': '\u8bbe\u7f6e50\u5206\u949f\u5012\u8ba1\u65f6'},
        'questions': {'route': {'type': 'choice', 'instructions': 'Choose the requested action.',
                       'criteria': {'countdown': 'Create a countdown timer', 'chat': 'Casual conversation'}}}})
    assert status == 200 and native.get('answers'), 'Native gateway request failed'
    try:
        api('/v1/audio/speech', {})
        raise RuntimeError('Decision-only key unexpectedly allowed speech')
    except urllib.error.HTTPError as error:
        denied_status = error.code
        assert denied_status == 403, 'Unexpected speech permission result'
    _, models, _ = api('/v1/models')
    ids = [x['id'] for x in models['data']]
    assert 'startlux-decision-4b' in ids and 'qwen3-tts-1.7b' not in ids
    report = {'key_id': entry['id'], 'permissions': entry['permissions'], 'native_status': status,
              'native_choice': native['answers']['route'].get('choice'), 'roundtrip_ms': latency,
              'speech_denied_status': denied_status, 'visible_models': ids,
              'env_file_mode': oct(env_path.stat().st_mode & 0o777)}
    out = env_path.parent / 'acceptance-B3-20261029.json'
    out.write_text(json.dumps(report, indent=2) + '\n');out.chmod(0o600)
    print(json.dumps(report))
finally:
    console('/logout', 'POST', {})
