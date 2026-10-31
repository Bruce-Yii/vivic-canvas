#!/usr/bin/env bash
set -euo pipefail
python3 - "$@" <<'PY'
import base64, io, json, os, re, subprocess, sys, tarfile, time
from pathlib import Path

request = json.loads(base64.b64decode(sys.argv[1]))
known = set(request.get('known', []))
since = request.get('since', 0)
root = Path('/opt/vivic-preview-20261025/releases')
selected = []
releases = []

def redact(value):
    if isinstance(value, list):
        return [redact(x) for x in value]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key.lower() in ['env', 'environment']:
                result[key] = '[REDACTED environment]'
            elif re.search(r'password|passwd|secret|credential|authorization|cookie|access.?token|refresh.?token|api.?key|private.?key|^token$', key, re.I) and not isinstance(item, (bool, int, float, type(None))):
                result[key] = '[REDACTED]'
            else:
                result[key] = redact(item)
        return result
    if isinstance(value, str):
        value = re.sub(r'Bearer\s+\S+', 'Bearer [REDACTED]', value, flags=re.I)
        value = re.sub(r'(https?://)[^/\s:@]+:[^/\s@]+@', r'\1[REDACTED]@', value)
    return value

for entry in sorted(root.iterdir()):
    if entry.is_symlink() or not entry.is_dir() or entry.name in known:
        continue
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', entry.name):
        raise ValueError('Unexpected release name')
    if entry.stat().st_mtime < since:
        continue
    files = []
    for item in entry.iterdir():
        if item.is_symlink():
            continue
        if item.is_file() and (item.name in ['README.md', 'verification.md', 'frontend-headers.conf'] or item.suffix == '.json'):
            files.append(item)
    patch = entry / 'patch'
    if patch.is_dir() and not patch.is_symlink():
        for item in patch.rglob('*'):
            if item.is_file() and not item.is_symlink() and entry.resolve() in item.resolve().parents:
                files.append(item)
    if files:
        releases.append(entry.name)
        selected.extend((p, p.relative_to(root).as_posix()) for p in sorted(files))
if sum(p.stat().st_size for p, _ in selected) > 60 * 1024 * 1024:
    raise ValueError('Patch archive exceeds 60 MiB')
metadata = {
    'version': 1, 'synced_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
    'sync_epoch': time.time(), 'releases': releases,
    'frontend': os.path.realpath('/opt/vivic-preview-20261025/frontend-current'),
    'container': 'vivic-preview-20261027',
    'image': subprocess.check_output(['docker', 'inspect', '--format', '{{.Config.Image}}', 'vivic-preview-20261027']).decode().strip(),
}
with tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as archive:
    data = json.dumps(metadata, ensure_ascii=True).encode()
    info = tarfile.TarInfo('_sync.json')
    info.size = len(data)
    archive.addfile(info, io.BytesIO(data))
    for source, name in selected:
        if source.suffix == '.json':
            data = (json.dumps(redact(json.loads(source.read_text(encoding='utf-8-sig'))), ensure_ascii=True, indent=2) + '\n').encode()
            info = archive.gettarinfo(str(source), arcname=name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        else:
            archive.add(str(source), arcname=name, recursive=False)
PY
