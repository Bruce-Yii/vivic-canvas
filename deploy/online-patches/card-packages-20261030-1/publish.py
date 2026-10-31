"""Package checked public assets and publish through the existing pinned SSH runner."""
import argparse
import base64
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('staging', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    repo = here.parents[2]
    staging = args.staging.resolve(strict=True)
    publication = json.loads((staging / 'publication-card-packages.json').read_text())
    output = repo.parent / 'tools/execution-20261030/f5-frontend-overlay.zip'
    with zipfile.ZipFile(repo / 'deploy/online-snapshot/frontend-before-card-packages-20261030.zip') as snapshot:
        base_manifest = snapshot.read('manifest.json')
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for item in publication['files']:
            archive.write(staging / item['path'], item['path'])
        archive.writestr('publication-card-packages.json', json.dumps(publication))
        archive.writestr('base-manifest.json', base_manifest)
    if not args.apply:
        print(json.dumps({'prepared': True, 'files': len(publication['files']), 'zip_bytes': output.stat().st_size}))
        return
    payload = base64.b64encode(output.read_bytes()).decode('ascii')
    script = (here / 'apply.py').read_text()
    archive_tag = hashlib.sha256(output.read_bytes()).hexdigest()[:12]
    remote = "import base64,sys\nfrom pathlib import Path\narchive=Path('/opt/vivic-preview-20261025/backend/card-packages-20261030-1-" + archive_tag + ".zip')\nif archive.exists(): raise RuntimeError('Upload already exists; inspect before retry')\narchive.write_bytes(base64.b64decode(" + repr(payload) + "))\nsys.argv=['apply.py',str(archive)]\n" + script
    result = subprocess.run([sys.executable, '-I', str(repo.parent / 'tools/vssh_python.py')], input=remote.encode(), capture_output=True)
    if result.returncode:
        raise RuntimeError('Frontend deployment failed: ' + result.stdout.decode()[-1500:] + result.stderr.decode()[-1500:])
    report = json.loads(result.stdout)
    (repo.parent / 'tools/execution-20261030/f5-deployment.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))

if __name__ == '__main__':
    main()
