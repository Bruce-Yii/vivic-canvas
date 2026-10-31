"""Apply one checked frontend overlay. Run by publish.py over pinned SSH stdin."""
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path('/opt/vivic-preview-20261025')
BASE = ROOT / 'releases/unified-background-20261029-1'
TARGET = ROOT / 'releases/card-packages-20261030-1'
POINTER = ROOT / 'frontend-current'
CONFIG = Path('/etc/nginx/conf.d/60-vivic-preview-20261025.conf')
ORIGIN = 'https://vivic.edsionc.top'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def swap(target):
    temporary = ROOT / 'frontend-current.card-packages-next'
    if temporary.exists() or temporary.is_symlink():
        raise RuntimeError('A frontend switch is already pending')
    temporary.symlink_to(target)
    os.replace(temporary, POINTER)

def health():
    with urllib.request.urlopen(ORIGIN + '/healthz', timeout=20) as response:
        if not json.load(response).get('ok'):
            raise RuntimeError('Backend health is not ok')
    with urllib.request.urlopen(ORIGIN + '/', timeout=20) as response:
        html = response.read().decode()
        if response.status != 200:
            raise RuntimeError('Homepage is unavailable')
    return html

def verify_base(manifest):
    expected = {row['path'] for row in manifest['files']} | {row['path'] for row in manifest['directories']}
    actual = {p.relative_to(BASE).as_posix() for p in BASE.rglob('*')}
    if expected != actual:
        raise RuntimeError('Current frontend file list changed; resync before deploying')
    for row in manifest['files']:
        path = BASE / row['path']
        if path.is_symlink() or digest(path.read_bytes()) != row['sha256']:
            raise RuntimeError('Current frontend changed: ' + row['path'])

def main(archive):
    lock = (ROOT / 'frontend-card-packages.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if not POINTER.is_symlink() or POINTER.resolve() != BASE / 'web' or TARGET.exists():
        raise RuntimeError('Unexpected current frontend or destination already exists')
    free = shutil.disk_usage(ROOT).free
    if free < 2 * 1024 ** 3 + 256 * 1024 ** 2:
        raise RuntimeError('Insufficient disk headroom')
    health()
    old_config = CONFIG.read_text()
    old_include = str(BASE / 'frontend-headers.conf')
    if old_config.count(old_include) != 2:
        raise RuntimeError('Nginx include changed; inspect before publishing')
    subprocess.run(['nginx', '-t'], check=True, capture_output=True)
    with zipfile.ZipFile(archive) as package:
        base_manifest = json.loads(package.read('base-manifest.json'))
        publication = json.loads(package.read('publication-card-packages.json'))
        verify_base(base_manifest)
        expected = {item['path'] for item in publication['files']}
        if set(package.namelist()) != expected | {'base-manifest.json', 'publication-card-packages.json'}:
            raise RuntimeError('Unexpected files in deployment overlay')
        if len(expected) > 512 or sum(item.file_size for item in package.infolist()) > 128 * 1024 ** 2:
            raise RuntimeError('Overlay exceeds bounds')
        for item in publication['files']:
            name = PurePosixPath(item['path'])
            if name.is_absolute() or '..' in name.parts or '\\' in item['path']:
                raise RuntimeError('Invalid overlay path')
            data = package.read(item['path'])
            if digest(data) != item['sha256']:
                raise RuntimeError('Overlay checksum mismatch')
        shutil.copytree(BASE, TARGET, symlinks=False)
        for item in publication['files']:
            path = TARGET / item['path']
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(package.read(item['path']))
            path.chmod(0o644)
        (TARGET / 'publication-card-packages.json').write_text(json.dumps(publication, indent=2))
    # Recheck right before the switch so a colleague's concurrent publication is never overwritten.
    verify_base(base_manifest)
    if POINTER.resolve() != BASE / 'web' or CONFIG.read_text() != old_config:
        raise RuntimeError('Frontend or nginx changed during preparation')
    stamp = time.strftime('%Y%m%dT%H%M%S')
    evidence = ROOT / 'evidence' / ('card-packages-' + stamp)
    evidence.mkdir(parents=True)
    (evidence / 'nginx.before.conf').write_text(old_config)
    switched = False
    try:
        swap(TARGET / 'web'); switched = True
        CONFIG.write_text(old_config.replace(old_include, str(TARGET / 'frontend-headers.conf')))
        subprocess.run(['nginx', '-t'], check=True, capture_output=True)
        subprocess.run(['nginx', '-s', 'reload'], check=True, capture_output=True)
        html = health()
        if '/assets/card-packages-20261030-1/' + publication['startup'] not in html:
            raise RuntimeError('Homepage did not select the new frontend')
        for filename in ['src-BByP9_62.js', 'card-packages.js', 'card-packages.css']:
            with urllib.request.urlopen(ORIGIN + '/assets/card-packages-20261030-1/' + filename, timeout=20) as response:
                if digest(response.read()) != digest((TARGET / 'web/assets/card-packages-20261030-1' / filename).read_bytes()):
                    raise RuntimeError('Published asset differs: ' + filename)
    except Exception:
        if switched:
            swap(BASE / 'web')
        CONFIG.write_text(old_config)
        subprocess.run(['nginx', '-t'], check=True, capture_output=True)
        subprocess.run(['nginx', '-s', 'reload'], check=True, capture_output=True)
        health()
        raise
    report = {'release': TARGET.name, 'base_files_verified': len(base_manifest['files']),
              'overlay_files_verified': len(publication['files']), 'backend_restarted': False,
              'health_ok': True, 'free_bytes': shutil.disk_usage(ROOT).free,
              'previous_frontend': str(BASE / 'web'), 'current_frontend': str(POINTER.resolve())}
    (evidence / 'deployment.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))

if __name__ == '__main__':
    main(Path(sys.argv[1]))
