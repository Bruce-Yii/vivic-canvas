"""Install on the Mac as muhan; stage service.py beside this installer first."""
import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

root = Path.home() / 'Library/Application Support/VivicModelAPI'
source = Path.home() / 'Library/Caches/vivic-model-evaluation-20261025/decision-comparison/models/startlux-4b-q8'
target = root / 'models/startlux-4b-q8'
service = root / 'decision-service'
python = root / 'runtime/venv-next/bin/python'
stamp = time.strftime('%Y%m%dT%H%M%S')
assert source.is_dir() and python.is_file() and (root / 'worker-token').is_file()
if not target.exists():
    shutil.copytree(source, target)
for p in source.iterdir():
    if p.is_file():
        assert (target / p.name).stat().st_size == p.stat().st_size, 'Model copy mismatch'
service.mkdir(mode=0o700, exist_ok=True)
destination = service / 'service.py'
if destination.exists(): shutil.copy2(destination, str(destination) + '.bak-' + stamp)
shutil.copy2(Path(__file__).with_name('service.py'), destination)
destination.chmod(0o600)
subprocess.check_call([str(python), '-m', 'py_compile', str(destination)])

plist = Path.home() / 'Library/LaunchAgents/com.vivic.decision.plist'
log = Path.home() / 'Library/Logs/vivic-decision.log'
log.parent.mkdir(parents=True, exist_ok=True)
log.touch(exist_ok=True)
log.chmod(0o600)
if plist.exists(): shutil.copy2(plist, str(plist) + '.bak-' + stamp)
configuration = {
    'Label': 'com.vivic.decision', 'RunAtLoad': True, 'KeepAlive': True,
    'ThrottleInterval': 5, 'AbandonProcessGroup': False,
    'WorkingDirectory': str(service),
    'ProgramArguments': [str(python), '-m', 'uvicorn', 'service:app', '--host',
                         '127.0.0.1', '--port', '19095', '--workers', '1', '--no-access-log'],
    'EnvironmentVariables': {'PYTHONUNBUFFERED': '1'},
    'StandardOutPath': str(log), 'StandardErrorPath': str(log)}
plist.write_bytes(plistlib.dumps(configuration))
domain = 'gui/' + str(os.getuid())
subprocess.run(['launchctl', 'bootout', domain + '/com.vivic.decision'],
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
subprocess.check_call(['launchctl', 'bootstrap', domain, str(plist)])
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for _ in range(120):
    try:
        with opener.open('http://127.0.0.1:19095/health', timeout=1) as response:
            health = json.load(response)
        if health.get('ok') and health.get('loaded'):
            print(json.dumps({'installed': True, 'health': health, 'launchd': configuration['Label']}))
            break
    except Exception:
        pass
    time.sleep(1)
else:
    raise RuntimeError('Decision service did not become healthy; inspect its log')
