"""Run on the server to restore the checked pre-card-packages frontend."""
import fcntl
import os
import subprocess
from pathlib import Path
ROOT = Path('/opt/vivic-preview-20261025')
previous = ROOT / 'releases/unified-background-20261029-1'
current = ROOT / 'releases/card-packages-20261030-1'
pointer = ROOT / 'frontend-current'
config = Path('/etc/nginx/conf.d/60-vivic-preview-20261025.conf')
lock = (ROOT / 'frontend-card-packages.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
text = config.read_text()
if not pointer.is_symlink() or pointer.resolve() != current / 'web' or text.count(str(current / 'frontend-headers.conf')) != 2 or not (previous / 'web/index.html').is_file():
    raise RuntimeError('Frontend changed since publication; inspect before rollback')
temporary = ROOT / 'frontend-current.card-packages-rollback'
if temporary.exists() or temporary.is_symlink():
    raise RuntimeError('A rollback is already pending')
temporary.symlink_to(previous / 'web')
os.replace(temporary, pointer)
config.write_text(text.replace(str(current / 'frontend-headers.conf'), str(previous / 'frontend-headers.conf')))
subprocess.run(['nginx', '-t'], check=True)
subprocess.run(['nginx', '-s', 'reload'], check=True)
print('FRONTEND_ROLLBACK_OK')
