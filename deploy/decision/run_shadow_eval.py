"""Run bounded paired replay, export synthetic-only results, always remove the baseline clone."""
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

root = Path('/opt/vivic-preview-20261025/backend')
smoke = '--smoke' in sys.argv
tag = 'smoke' if smoke else 'full'
case = sys.argv[sys.argv.index('--case') + 1] if '--case' in sys.argv else None
if case:
    assert re.fullmatch('[a-z0-9-]+', case)
    tag = 'diagnostic-' + case
lock = (root / 'evaluation.lock').open('w')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
container = 'vivic-preview-20261027'
directory = '/tmp/vivic-decision-eval'
report = root / ('replay-' + tag + '-20261029.json')
try:
    subprocess.check_call(['docker', 'exec', '--user', 'root', container, 'install', '-d', '-m', '700', '-o', 'node', '-g', 'node', directory])
    for source, target in [(root / 'replay-eval.mjs', '/app/apps/local-api/decision-replay.mjs'),
                           (root / 'eval-dataset.json', directory + '/dataset.json'),
                           (root / 'eval-session-20261029.json', directory + '/session.json')]:
        subprocess.check_call(['docker', 'cp', str(source), container + ':' + target])
        subprocess.check_call(['docker', 'exec', '--user', 'root', container, 'chown', 'node:node', target])
    command = ['docker', 'exec', '--user', 'node', container, 'node', '--import', 'tsx',
               '/app/apps/local-api/decision-replay.mjs', '--credentials', directory + '/session.json',
               '--dataset', directory + '/dataset.json', '--output', directory + '/result.json']
    if smoke: command.append('--smoke')
    if case: command += ['--case', case]
    if '--sequential' in sys.argv: command.append('--sequential')
    result = subprocess.run(command, timeout=7200)
    copied = subprocess.run(['docker', 'cp', container + ':' + directory + '/result.json', str(report)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if copied.returncode == 0:
        report.chmod(0o600)
        value = json.loads(report.read_text())
        print(json.dumps({'report': str(report), 'complete': value.get('complete'), 'count': value.get('count'),
                          'route_accuracy': value.get('routeAccuracy'), 'failure': value.get('failure')}), flush=True)
    if result.returncode: raise SystemExit(result.returncode)
finally:
    subprocess.run(['python3.9', str(root / 'prepare_shadow_eval.py'), 'cleanup'], check=True)
    subprocess.run(['docker', 'exec', '--user', 'root', container, 'rm', '-rf', '--', directory],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['docker', 'exec', '--user', 'root', container, 'rm', '-f', '--', '/app/apps/local-api/decision-replay.mjs'],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
