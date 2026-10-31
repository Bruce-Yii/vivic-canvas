"""Prepare only the fixed, reviewed Kev runtime; no model, audio or tools run here."""
import argparse, concurrent.futures, hashlib, json, os, platform, shutil, subprocess, sys, urllib.request
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()

def main():
    args = argparse.ArgumentParser(); args.add_argument('--cache-dir', type=Path, required=True); cache = args.parse_args().cache_dir.resolve()
    if platform.system() != 'Darwin' or platform.machine() != 'arm64': raise RuntimeError('This fixed runtime requires Apple Silicon')
    manifest = json.loads((HERE/'manifest.json').read_text()); cache.mkdir(parents=True, exist_ok=True)
    evaluation = ROOT/'.cache/kev-evaluation'
    jobs = []
    for row in manifest['sourceFiles']:
        jobs.append((row, cache/'source'/row['file'], evaluation/'source'/row['file'], 'https://raw.githubusercontent.com/jaredpalmer/kev/'+manifest['sourceRevision']+'/'+row['file']))
    for row in manifest['modelFiles']:
        relative = row['file'].split('/', 1)[1]
        jobs.append((row, cache/'model'/row['file'], evaluation/'model'/row['file'], f"https://huggingface.co/{row['repo']}/resolve/{row['revision']}/{relative}"))
    total = sum(row['bytes'] for row, *_ in jobs)
    print(json.dumps({'phase':'downloading','bytes':total}), flush=True)
    def fetch(job):
        row, target, reusable, url = job; target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.stat().st_size == row['bytes'] and digest(target) == row['sha256']: return
        if reusable.exists() and reusable.stat().st_size == row['bytes'] and digest(reusable) == row['sha256']:
            if target.exists(): target.unlink()
            try: os.link(reusable, target)
            except OSError: shutil.copyfile(reusable, target)
        else:
            partial = target.with_suffix(target.suffix+'.part')
            with urllib.request.urlopen(url, timeout=30) as response, partial.open('wb') as output:
                read = 0
                while chunk := response.read(1024 * 1024):
                    read += len(chunk)
                    if read > row['bytes']: raise RuntimeError('Model exceeds fixed size')
                    output.write(chunk)
            if partial.stat().st_size != row['bytes'] or digest(partial) != row['sha256']: raise RuntimeError('Model hash mismatch')
            partial.replace(target)
        if digest(target) != row['sha256']: raise RuntimeError('Model hash mismatch')
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool: list(pool.map(fetch, jobs))
    print(json.dumps({'phase':'installing'}), flush=True)
    env = cache/'venv'
    if not (env/'bin/python').exists(): subprocess.run(['uv','venv',str(env),'--python','3.12'],check=True,timeout=180,stdout=sys.stderr)
    subprocess.run(['uv','pip','install','--python',str(env/'bin/python'),'-r',str(HERE/'requirements.lock')],check=True,timeout=300,stdout=sys.stderr)
    print(json.dumps({'phase':'cached'}), flush=True)

if __name__ == '__main__': main()
