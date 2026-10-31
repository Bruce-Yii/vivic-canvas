"""Add a native 4B forwarding branch to the existing Mac supervisor."""
import ast
import json
import os
import re
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

root = Path.home() / 'Library/Application Support/VivicModelAPI'
path = root / 'file-api-20261026/supervisor.py'
python = root / 'runtime/venv-next/bin/python'
original = path.read_text()
marker = '# Independent resident 4B service; keep legacy scheduling unchanged.'
changed = marker not in original
if changed:
    catalog = "MODEL_INFO[-1]['license']='CC-BY-NC-4.0';MODEL_INFO[-1]['evaluation_only']=True"
    assert original.count(catalog) == 1
    added = "\nMODEL_INFO.append({'id':'startlux-decision-4b','object':'model','owned_by':'vivic','task':'classification','name':'StartLux Decision 4B Q8 resident','license':'CC-BY-NC-4.0','evaluation_only':True})"
    replacement = original.replace(catalog, catalog + added)
    prefix = ' data=await small_json(request);name='
    assert replacement.count(prefix) == 1
    branch = ''' data=await small_json(request)
 # Independent resident 4B service; keep legacy scheduling unchanged.
 if data.get('model')=='startlux-decision-4b':
  import aiohttp
  try:
   async with aiohttp.ClientSession(trust_env=False,timeout=aiohttp.ClientTimeout(total=20)) as client:
    async with client.post('http://127.0.0.1:19095/v1/native',json=data,headers={'Authorization':request.headers.get('authorization','')}) as response:
     return Response(content=await response.read(),status_code=response.status,media_type='application/json')
  except (aiohttp.ClientError,asyncio.TimeoutError):
   raise HTTPException(503,'Resident decision service is temporarily unavailable') from None
 name='''
    replacement = replacement.replace(prefix, branch)
    ast.parse(replacement)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    headers = {'Authorization': 'Bearer ' + (root / 'worker-token').read_text().strip()}
    for _ in range(120):
        with opener.open(urllib.request.Request('http://127.0.0.1:19090/health', headers=headers), timeout=3) as response:
            status = json.load(response)
        if not status.get('busy') and status.get('queue', 0) == 0:
            break
        time.sleep(.5)
    else:
        raise RuntimeError('Existing worker is still busy; did not restart it')
    assert path.read_text() == original, 'Supervisor changed during preparation'
    backup = str(path) + '.bak-' + time.strftime('%Y%m%dT%H%M%S')
    shutil.copy2(path, backup)
    path.write_text(replacement)
    subprocess.check_call([str(python), '-m', 'py_compile', str(path)])
    label = 'gui/' + str(os.getuid()) + '/com.vivic.model-api'

    def pid():
        value = subprocess.check_output(['launchctl', 'print', label]).decode()
        match = re.search(r'^\s*pid = (\d+)', value, re.M)
        return int(match.group(1)) if match else None

    previous_pid = pid()
    # SIGTERM lets the existing supervisor close its model process and file jobs.
    subprocess.check_call(['launchctl', 'kill', 'SIGTERM', label])
    for _ in range(120):
        try:
            current_pid = pid()
            with opener.open(urllib.request.Request('http://127.0.0.1:19090/health', headers=headers), timeout=2) as response:
                status = json.load(response)
            if current_pid and current_pid != previous_pid and status.get('ok'):
                break
        except Exception:
            pass
        time.sleep(.5)
    else:
        shutil.copy2(backup, path)
        subprocess.run(['launchctl', 'kickstart', '-k', label])
        raise RuntimeError('Worker did not restart; restored original source')
    print(json.dumps({'changed': True, 'backup': backup, 'worker_ready': True,
                      'model_catalog_contains_4b': any(x['id'] == 'startlux-decision-4b' for x in status['models'])}))
else:
    print(json.dumps({'changed': False, 'already_installed': True}))
