"""Register native 4B in the existing server gateway, with automatic rollback."""
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

root = Path('/opt/vivic-model-api')
paths = [root / 'gateway.mjs', root / 'api-permissions.mjs']
needle = "'startlux-decision-2b','gliner2.5-multi-decide','laya-multilingual'"
replacement = "'startlux-decision-2b','startlux-decision-4b','gliner2.5-multi-decide','laya-multilingual'"
backups = []
stamp = time.strftime('%Y%m%dT%H%M%S')
try:
    for p in paths:
        original = p.read_text()
        if replacement in original:
            continue
        assert original.count(needle) == 1, 'Gateway code differs from the inspected version'
        backup = Path(str(p) + '.bak-' + stamp)
        shutil.copy2(p, backup)
        backups.append((p, backup))
        p.write_text(original.replace(needle, replacement))
        subprocess.check_call(['node', '--check', str(p)])
    if backups:
        subprocess.check_call(['systemctl', 'restart', 'vivic-model-api'])
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(30):
        try:
            with opener.open('http://127.0.0.1:8796/api/health', timeout=2) as response:
                if response.status == 200: break
        except Exception: pass
        time.sleep(.5)
    else:
        raise RuntimeError('Gateway health check failed')
except Exception:
    for p, backup in backups: shutil.copy2(backup, p)
    if backups: subprocess.run(['systemctl', 'restart', 'vivic-model-api'])
    raise
print('GATEWAY_NATIVE_4B_READY')
