#!/usr/bin/env python3
"""Download only the reviewed, pinned Laya candidate. No credentials or remote execution."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import time
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def download(url, dest, expected, size):
    if dest.is_file() and dest.stat().st_size == size and digest(dest) == expected:
        return 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_name(dest.name + '.partial')
    count = 0
    started = time.monotonic()
    try:
        with urllib.request.urlopen(url, timeout=60) as response, partial.open('wb') as out:
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                count += len(block)
                if time.monotonic() - started > 300:
                    raise TimeoutError('Artifact download exceeded 300 seconds: ' + dest.name)
                if count > size:
                    raise ValueError('Download exceeds locked size: ' + dest.name)
                out.write(block)
                if count // (64 * 1024 * 1024) != (count - len(block)) // (64 * 1024 * 1024):
                    print(dest.name, count, 'bytes', flush=True)
        if count != size or digest(partial) != expected:
            raise ValueError('Artifact integrity mismatch: ' + dest.name)
        partial.replace(dest)
        return count
    finally:
        partial.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', type=Path, default=ROOT / '.cache/laya-poc')
    parser.add_argument('--model', choices=['laya-multilingual'], default='laya-multilingual')
    parser.add_argument('--artifacts-only', action='store_true')
    args = parser.parse_args()
    cache = args.cache_dir.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    lock = json.loads((HERE / 'artifacts.lock.json').read_text())
    evidence = ROOT / 'evidence/phase2-decision'
    evidence.mkdir(parents=True, exist_ok=True)
    report = {'status': 'PREPARING', 'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'cache_dir': str(cache), 'downloaded_artifact_bytes_this_run': 0}
    try:
        if not args.artifacts_only and (platform.system() != 'Darwin' or platform.machine() != 'arm64'):
            raise RuntimeError('Dependency download budget verified only for macOS arm64; use --artifacts-only elsewhere')
        source = lock['source']
        source_dir = cache / 'source'
        source_ok = all((source_dir / name).is_file() and digest(source_dir / name) == sha
                        for name, sha in source['reviewed_files'].items())
        if not source_ok:
            archive = cache / 'source.tar.gz'
            report['downloaded_artifact_bytes_this_run'] += download(
                'https://codeload.github.com/NandhaKishorM/laya/tar.gz/' + source['commit'],
                archive, source['archive_sha256'], source['archive_bytes'])
            with tarfile.open(archive) as tar:
                for member in tar.getmembers():
                    rel = Path(*Path(member.name).parts[1:])
                    if str(rel) not in source['reviewed_files']:
                        continue
                    if not member.isfile() or '..' in rel.parts:
                        raise ValueError('Unexpected archive entry')
                    dest = source_dir / rel
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(tar.extractfile(member).read())
            if not all(digest(source_dir / n) == h for n, h in source['reviewed_files'].items()):
                raise ValueError('Reviewed source mismatch')
        for entry in lock['model']['files']:
            url = ('https://huggingface.co/' + lock['model']['repo'] + '/resolve/' +
                   lock['model']['revision'] + '/' + entry['path'])
            print('verify/download', entry['path'], flush=True)
            report['downloaded_artifact_bytes_this_run'] += download(
                url, cache / 'model' / entry['path'], entry['sha256'], entry['bytes'])
        if not args.artifacts_only:
            env = dict(os.environ, UV_CACHE_DIR=str(cache / 'uv'),
                       UV_PYTHON_INSTALL_DIR=str(cache / 'python'))
            python = cache / 'venv/bin/python'
            if not python.exists():
                subprocess.run(['uv', 'venv', '--python', lock['python'], str(cache / 'venv')],
                               env=env, check=True, timeout=300)
            subprocess.run(['uv', 'pip', 'install', '--python', str(python), '--only-binary',
                            ':all:', '-r', str(HERE / 'requirements.lock')], env=env, check=True, timeout=300)
        report['status'] = 'READY'
        report['model_bytes'] = sum(f['bytes'] for f in lock['model']['files'])
        report['model_revision'] = lock['model']['revision']
        report['source_commit'] = source['commit']
    except Exception as exc:
        report.update(status='BLOCKED', reason=type(exc).__name__ + ': ' + str(exc))
    (evidence / 'prepare.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'READY' else 2


if __name__ == '__main__':
    sys.exit(main())
