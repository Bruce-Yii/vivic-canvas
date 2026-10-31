"""Content-deduplicated, hash-verified backup of a complete deployed frontend."""
import argparse
import hashlib
import json
import os
import re
import stat
import time
import zipfile
from pathlib import Path, PurePosixPath


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(name):
    p = PurePosixPath(name)
    if p.is_absolute() or not p.parts or '..' in p.parts or '\\' in name:
        raise ValueError('Unsafe snapshot path')
    return p


def pack(source, archive):
    source = source.resolve(strict=True)
    if source == archive.resolve() or source in archive.resolve().parents:
        raise ValueError('Archive must be outside source')
    archive.parent.mkdir(parents=True, exist_ok=True)
    files, directories, written = [], [], set()
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(source.rglob('*')):
            if p.is_symlink():
                raise ValueError('Snapshot source contains a symlink: ' + str(p))
            relative = p.relative_to(source).as_posix()
            safe_path(relative)
            mode = stat.S_IMODE(p.stat().st_mode)
            if p.is_dir():
                directories.append({'path': relative, 'mode': mode})
                continue
            if p.name.startswith('.env') or p.suffix in ['.key', '.pem', '.sqlite', '.db']:
                raise ValueError('Unexpected private file in public frontend')
            before = p.stat()
            data = p.read_bytes()
            after = p.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise RuntimeError('Source changed during backup')
            sha = digest(data)
            files.append({'path': relative, 'sha256': sha, 'bytes': len(data), 'mode': mode})
            if sha not in written:
                z.writestr('objects/' + sha, data)
                written.add(sha)
        manifest = {'format': 'vivic.frontend.snapshot.v1', 'release': source.name,
                    'created_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
                    'files': files, 'directories': directories}
        z.writestr('manifest.json', json.dumps(manifest, ensure_ascii=True, indent=2))
    verify(archive, source)
    return {'release': source.name, 'files': len(files), 'objects': len(written),
            'original_bytes': sum(x['bytes'] for x in files),
            'archive_bytes': archive.stat().st_size, 'archive_sha256': digest(archive.read_bytes())}


def verify(archive, source=None, destination=None):
    with zipfile.ZipFile(archive) as z:
        manifest = json.loads(z.read('manifest.json'))
        if manifest.get('format') != 'vivic.frontend.snapshot.v1':
            raise ValueError('Unknown snapshot format')
        paths, objects = set(), set()
        for item in manifest['directories'] + manifest['files']:
            p = safe_path(item['path'])
            if p.as_posix() in paths:
                raise ValueError('Duplicate snapshot path')
            paths.add(p.as_posix())
        if source:
            actual = {p.relative_to(source).as_posix() for p in source.rglob('*')}
            if actual != paths:
                raise RuntimeError('Live source file list changed')
        if destination:
            destination = destination.resolve()
            destination.mkdir(exist_ok=False)
            for item in manifest['directories']:
                target = destination.joinpath(*safe_path(item['path']).parts)
                target.mkdir(parents=True, exist_ok=True)
                target.chmod(item['mode'])
        for item in manifest['files']:
            sha = item['sha256']
            if not re.fullmatch('[a-f0-9]{64}', sha):
                raise ValueError('Invalid content hash')
            if sha not in objects:
                data = z.read('objects/' + sha)
                if len(data) != item['bytes'] or digest(data) != sha:
                    raise ValueError('Corrupt snapshot object')
                objects.add(sha)
            if source:
                p = source.joinpath(*safe_path(item['path']).parts)
                if p.is_symlink() or digest(p.read_bytes()) != sha:
                    raise RuntimeError('Live source content changed')
            if destination:
                target = destination.joinpath(*safe_path(item['path']).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as f:
                    f.write(z.read('objects/' + sha))
                target.chmod(item['mode'])
        return {'verified_files': len(manifest['files']), 'verified_objects': len(objects)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('pack')
    p.add_argument('source', type=Path)
    p.add_argument('archive', type=Path)
    p = sub.add_parser('verify')
    p.add_argument('archive', type=Path)
    p.add_argument('--source', type=Path)
    p = sub.add_parser('restore')
    p.add_argument('archive', type=Path)
    p.add_argument('destination', type=Path)
    args = parser.parse_args()
    if args.command == 'pack':
        result = pack(args.source, args.archive)
    elif args.command == 'verify':
        result = verify(args.archive, args.source)
    else:
        result = verify(args.archive, destination=args.destination)
    print(json.dumps(result, ensure_ascii=True))
