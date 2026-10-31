"""Operator-only evaluation setup. Normal registration/owner APIs, no SQL edits."""
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from http.cookies import SimpleCookie
from pathlib import Path

ROOT = Path('/opt/vivic-preview-20261025/backend')
ENV = ROOT / 'env.list'
PRIVATE = ROOT / 'eval-credentials-20261029.json'
BASELINE = 'vivic-shadow-baseline'
DATA = Path('/var/lib/vivic-shadow-baseline')


def environment():
    return dict(s.split('=', 1) for s in ENV.read_text().splitlines() if s and not s.startswith('#') and '=' in s)


def replace_environment(values):
    old = ENV.read_text()
    backup = Path(str(ENV) + '.bak-eval-' + time.strftime('%Y%m%dT%H%M%S'))
    shutil.copy2(ENV, backup)
    lines = [s for s in old.splitlines() if s.split('=', 1)[0] not in values]
    lines += [k + '=' + v for k, v in values.items() if v is not None]
    temporary = ENV.with_suffix('.tmp')
    temporary.write_text('\n'.join(lines) + '\n');temporary.chmod(0o600);temporary.replace(ENV)


def save(value):
    PRIVATE.write_text(json.dumps(value, indent=2) + '\n');PRIVATE.chmod(0o600)


def configure():
    env = environment()
    if PRIVATE.exists():
        value = json.loads(PRIVATE.read_text())
    else:
        value = {'evaluation': True, 'username': 'decision-eval-20261029-' + secrets.token_hex(3),
                 'password': secrets.token_urlsafe(32), 'invite': secrets.token_urlsafe(32),
                 'original_invite': env.get('VIVIC_SPACE_INVITE'), 'origin': env['VIVIC_ONLINE_ORIGIN']}
        save(value)
    updates = {'VIVIC_DECISION_MODE': 'shadow'}
    if not value.get('accountId'): updates['VIVIC_SPACE_INVITE'] = value['invite']
    replace_environment(updates)
    print(json.dumps({'shadow_configured': True, 'test_registration_prepared': not bool(value.get('accountId'))}))


def register():
    value = json.loads(PRIVATE.read_text())
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    headers = {'Origin': value['origin'], 'Content-Type': 'application/json'}

    def api(route, method='GET', body=None):
        req = urllib.request.Request(value['origin'] + route,
            data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
        with opener.open(req, timeout=20) as response:
            cookie = response.headers.get('Set-Cookie')
            if cookie:
                parsed = SimpleCookie();parsed.load(cookie)
                headers['Cookie'] = '; '.join(k + '=' + v.value for k, v in parsed.items())
            return json.load(response)

    if value.get('cookie'): headers['Cookie'] = value['cookie']
    if not value.get('accountId'):
        try:
            session = api('/api/space/register', 'POST', {k: value[k] for k in ['username', 'password', 'invite']})
        except urllib.error.HTTPError as error:
            if error.code not in [403, 409]: raise
            session = api('/api/space/login', 'POST', {k: value[k] for k in ['username', 'password']})
    else:
        session = api('/api/space/login', 'POST', {k: value[k] for k in ['username', 'password']})
    assert session['user']['username'] == value['username'] and value['username'].startswith('decision-eval-')
    value['accountId'] = session['user']['id'];value['cookie'] = headers['Cookie']
    canvases = api('/api/space/owner/canvases')['canvases']
    assert len(canvases) == 1, 'Evaluation account must have one isolated Space'
    value['spaceId'] = canvases[0]['record']['id']
    save(value)
    replace_environment({'VIVIC_SPACE_INVITE': value.get('original_invite')})
    print(json.dumps({'evaluation_registered': True, 'account_id': value['accountId'], 'space_id': value['spaceId']}))


def baseline():
    value = json.loads(PRIVATE.read_text())
    assert value.get('evaluation') and value.get('accountId')
    existing = subprocess.run(['docker', 'inspect', BASELINE], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if existing.returncode == 0:
        container = json.loads(existing.stdout)[0]
        assert container['Config'].get('Labels', {}).get('vivic.managed') == 'decision-eval'
        raise RuntimeError('A baseline container exists; inspect the prior replay before replacing it')
    assert not DATA.exists() and not DATA.is_symlink()
    source = Path('/var/lib/vivic-preview-20261025')
    subprocess.check_call(['cp', '-a', str(source), str(DATA)])
    (DATA / 'space.lock').unlink(missing_ok=True)
    image = subprocess.check_output(['docker', 'inspect', '--format', '{{.Config.Image}}', 'vivic-preview-20261027']).decode().strip()
    code = "import {DatabaseSync,backup} from 'node:sqlite';const db=new DatabaseSync('/data/vivic/space.sqlite',{readOnly:true});await backup(db,'/copy/consistent.sqlite');db.close();"
    subprocess.check_call(['docker', 'run', '--rm', '--user', 'node', '-v', str(source) + ':/data/vivic:ro', '-v', str(DATA) + ':/copy',
                           '--entrypoint', 'node', image, '--no-warnings', '--input-type=module', '-e', code])
    for name in ['space.sqlite', 'space.sqlite-wal', 'space.sqlite-shm']:
        (DATA / name).unlink(missing_ok=True)
    (DATA / 'consistent.sqlite').replace(DATA / 'space.sqlite')
    subprocess.check_call(['docker', 'run', '-d', '--name', BASELINE, '--label', 'vivic.managed=decision-eval',
                           '--user', 'node', '--workdir', '/app/apps/local-api', '--env-file', str(ENV),
                           '-e', 'VIVIC_DECISION_MODE=off', '-p', '127.0.0.1:18891:8790', '-v', str(DATA) + ':/data/vivic',
                           image, 'node', '--import', 'tsx', 'src/online/index.ts'], stdout=subprocess.DEVNULL)
    for _ in range(45):
        try:
            with urllib.request.urlopen('http://127.0.0.1:18891/healthz', timeout=2) as response:
                if json.load(response).get('ok'): break
        except Exception: pass
        time.sleep(.5)
    else: raise RuntimeError('Evaluation baseline did not become ready')
    info = json.loads(subprocess.check_output(['docker', 'inspect', BASELINE]))[0]
    ip = next(iter(info['NetworkSettings']['Networks'].values()))['IPAddress']
    value['baselineURL'] = 'http://' + ip + ':8790'
    save(value)
    session = {k: value[k] for k in ['evaluation', 'username', 'accountId', 'spaceId', 'cookie', 'origin', 'baselineURL']}
    session_path = ROOT / 'eval-session-20261029.json'
    session_path.write_text(json.dumps(session));session_path.chmod(0o600)
    print(json.dumps({'baseline_ready': True, 'loopback_port': 18891, 'session_prepared': True}))


def cleanup():
    result = subprocess.run(['docker', 'inspect', BASELINE], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if result.returncode == 0:
        info = json.loads(result.stdout)[0]
        assert info['Config'].get('Labels', {}).get('vivic.managed') == 'decision-eval'
        subprocess.check_call(['docker', 'rm', '-f', BASELINE], stdout=subprocess.DEVNULL)
    if DATA.exists():
        assert DATA.resolve() == Path('/var/lib/vivic-shadow-baseline') and not DATA.is_symlink()
        shutil.rmtree(DATA)
    print(json.dumps({'baseline_removed': True}))


if __name__ == '__main__':
    {'configure': configure, 'register': register, 'baseline': baseline, 'cleanup': cleanup}[sys.argv[1]]()
