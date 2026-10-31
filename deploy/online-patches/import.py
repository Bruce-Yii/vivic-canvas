"""Import only new release archives; reject links, traversal, and existing releases."""
import json
import os
import re
import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath

archive_path, destination = map(Path, sys.argv[1:3])
destination = destination.resolve(strict=True)
created = []
with tarfile.open(str(archive_path), 'r:') as archive:
    members = archive.getmembers()
    meta_member = archive.getmember('_sync.json')
    if not meta_member.isfile() or meta_member.size > 65536:
        raise ValueError('Invalid metadata')
    meta = json.load(archive.extractfile(meta_member))
    releases = meta['releases']
    if len(set(releases)) != len(releases):
        raise ValueError('Duplicate release')
    for name in releases:
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name):
            raise ValueError('Invalid release name')
        if os.path.lexists(str(destination / name)):
            raise FileExistsError('Refusing to overwrite: ' + name)
    if sum(m.size for m in members) > 64 * 1024 * 1024:
        raise ValueError('Archive too large')
    names = set()
    for member in members:
        if member.name == '_sync.json':
            continue
        path = PurePosixPath(member.name)
        if (not member.isfile() or path.is_absolute() or len(path.parts) < 2
                or '..' in path.parts or '\\' in member.name
                or path.parts[0] not in releases or member.name in names):
            raise ValueError('Invalid archive member: ' + member.name)
        if not (path.parts[1] == 'patch' or (len(path.parts) == 2 and
                (path.name in ['README.md', 'verification.md', 'frontend-headers.conf']
                 or path.suffix == '.json'))):
            raise ValueError('Unexpected release content')
        names.add(member.name)
    try:
        for name in releases:
            target = destination / name
            target.mkdir()
            created.append(target)
        for member in members:
            if member.name == '_sync.json':
                continue
            target = destination.joinpath(*PurePosixPath(member.name).parts)
            if destination not in target.resolve().parents:
                raise ValueError('Path escaped destination')
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as output:
                shutil.copyfileobj(archive.extractfile(member), output)
    except Exception:
        for target in created:
            resolved = target.resolve()
            if resolved.parent != destination or target.is_symlink():
                raise ValueError('Unsafe cleanup target')
            shutil.rmtree(str(resolved))
        raise
print(json.dumps(meta, ensure_ascii=True))
