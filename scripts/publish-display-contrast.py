"""Publish a scoped NewsCard surface fix on the checked current frontend."""
import argparse
import base64
import hashlib
import io
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PATCH = REPO / 'deploy/online-patches/display-contrast-20261030-1'
OLD = 'card-packages-20261030-1'
NEW = 'display-contrast-20261030-1'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--repair-cascade', action='store_true')
    args = parser.parse_args()
    runner = REPO.parent / 'tools/vssh_python.py'
    if args.repair_cascade:
        css = base64.b64encode((PATCH / 'display-contrast.css').read_bytes()).decode()
        with zipfile.ZipFile(REPO / ('deploy/online-snapshot/frontend-' + OLD + '.zip')) as archive:
            base = base64.b64encode(archive.read('manifest.json')).decode()
        code = '''import base64,json,hashlib,os,urllib.request,fcntl
from pathlib import Path
root=Path('/opt/vivic-preview-20261025')
release=root/'releases/display-contrast-20261030-1'
pointer=root/'frontend-current'
lock=(root/'frontend-card-packages.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
assert pointer.resolve()==release/'web'
base=json.loads(base64.b64decode(BASE_PAYLOAD))
publication_path=release/'publication-card-packages.json'
old_publication=publication_path.read_text();publication=json.loads(old_publication)
assert publication['release']=='display-contrast-20261030-1' and publication['base']=='card-packages-20261030-1' and len(publication['files'])==3
overrides={x['path']:x for x in publication['files']}
for row in base['files']:
 if row['path']=='publication-card-packages.json':continue
 expected=overrides.get(row['path'],row)['sha256']
 assert hashlib.sha256((release/row['path']).read_bytes()).hexdigest()==expected,'Current frontend changed'
for row in publication['files']:assert hashlib.sha256((release/row['path']).read_bytes()).hexdigest()==row['sha256']
index_path=release/'web/index.html';old_index=index_path.read_text()
old_name='display-contrast-20261030-1.css';new_name='display-contrast-20261030-2.css'
assert old_index.count(old_name)==1
css_path=release/'web/assets/card-packages-20261030-1'/new_name
assert not css_path.exists()
css=base64.b64decode(CSS_PAYLOAD);css_path.write_bytes(css);css_path.chmod(0o644)
new_index=old_index.replace(old_name,new_name)
temporary=index_path.with_name('index.html.contrast-next');assert not temporary.exists();temporary.write_text(new_index);temporary.replace(index_path)
publication['revision']=2
for row in publication['files']:
 if row['path']=='web/index.html':row['sha256']=hashlib.sha256(new_index.encode()).hexdigest()
publication['files'].append({'path':'web/assets/card-packages-20261030-1/'+new_name,'sha256':hashlib.sha256(css).hexdigest()})
try:
 with urllib.request.urlopen('https://vivic.edsionc.top/assets/card-packages-20261030-1/'+new_name,timeout=20) as r:assert hashlib.sha256(r.read()).digest()==hashlib.sha256(css).digest()
 with urllib.request.urlopen('https://vivic.edsionc.top/healthz',timeout=20) as r:assert json.load(r)['ok']
 publication_path.write_text(json.dumps(publication,indent=2))
except Exception:
 index_path.write_text(old_index);publication_path.write_text(old_publication);raise
print(json.dumps({'release':release.name,'revision':2,'css_file':new_name,'health_ok':True,'backend_restarted':False}))
'''.replace('BASE_PAYLOAD', repr(base)).replace('CSS_PAYLOAD', repr(css))
        result = subprocess.run([sys.executable, '-I', str(runner)], input=code.encode(), capture_output=True)
        if result.returncode:
            raise RuntimeError('Cascade repair failed: ' + result.stderr.decode()[-1600:])
        report = json.loads(result.stdout)
        (PATCH / 'cascade-repair.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
        print(json.dumps(report))
        return
    if args.rollback:
        code = (REPO / 'deploy/online-patches/card-packages-20261030-1/rollback.py').read_text(encoding='utf8')
        code = code.replace("previous = ROOT / 'releases/unified-background-20261029-1'", "previous = ROOT / 'releases/" + OLD + "'")
        code = code.replace("current = ROOT / 'releases/card-packages-20261030-1'", "current = ROOT / 'releases/" + NEW + "'")
        result = subprocess.run([sys.executable, '-I', str(runner)], input=code.encode(), capture_output=True)
        if result.returncode:
            raise RuntimeError('Rollback failed: ' + result.stderr.decode()[-1200:])
        print(result.stdout.decode().strip())
        return
    with zipfile.ZipFile(REPO / ('deploy/online-snapshot/frontend-' + OLD + '.zip')) as archive:
        manifest = json.loads(archive.read('manifest.json'))
        files = {row['path']: row for row in manifest['files']}
        index = archive.read('objects/' + files['web/index.html']['sha256']).decode()
        headers = archive.read('objects/' + files['frontend-headers.conf']['sha256']).decode()
    css_name = NEW + '.css'
    css_path = 'web/assets/' + OLD + '/' + css_name
    css_link = '<link rel="stylesheet" href="/assets/' + OLD + '/' + css_name + '"></head>'
    if css_name in index or index.count('</head>') != 1:
        raise RuntimeError('Unexpected base HTML')
    startup = re.search(r'/assets/' + re.escape(OLD) + r'/(vivic-startup-v\d+\.js)', index)
    if not startup:
        raise RuntimeError('Expected current startup script')
    changed = {'web/index.html': index.replace('</head>', css_link).replace('content="' + OLD + '"', 'content="' + NEW + '"').encode(),
               'frontend-headers.conf': headers.replace(OLD, NEW).encode(),
               css_path: (PATCH / 'display-contrast.css').read_bytes()}
    publication = {'release': NEW, 'base': OLD, 'startup': startup.group(1),
                   'files': [{'path': path, 'sha256': hashlib.sha256(data).hexdigest()} for path, data in changed.items()]}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('base-manifest.json', json.dumps(manifest))
        archive.writestr('publication-card-packages.json', json.dumps(publication))
        for path, data in changed.items():
            archive.writestr(path, data)
    if not args.apply:
        print(json.dumps({'prepared': True, 'base_files': len(manifest['files']), 'changed_files': len(changed), 'zip_bytes': len(buffer.getvalue())}))
        return
    source = (REPO / 'deploy/online-patches/card-packages-20261030-1/apply.py').read_text(encoding='utf8')
    anchor = "['src-BByP9_62.js', 'card-packages.js', 'card-packages.css']"
    if source.count(anchor) != 1:
        raise RuntimeError('Checked deployment verifier changed')
    source = source.replace(anchor, "['src-BByP9_62.js', 'card-packages.js', 'card-packages.css', '" + css_name + "']")
    payload = base64.b64encode(buffer.getvalue()).decode()
    code = "import base64\nfrom pathlib import Path\narchive=Path('/opt/vivic-preview-20261025/backend/display-contrast-" + hashlib.sha256(buffer.getvalue()).hexdigest()[:12] + ".zip')\n"
    code += "if archive.exists(): raise RuntimeError('Deployment upload already exists')\narchive.write_bytes(base64.b64decode(" + repr(payload) + "))\n"
    code += "namespace={'__name__':'display_contrast_deploy'}\nexec(compile(" + repr(source) + ",'checked-frontend-deploy','exec'),namespace)\n"
    code += "namespace['BASE']=namespace['ROOT']/'releases/" + OLD + "'\nnamespace['TARGET']=namespace['ROOT']/'releases/" + NEW + "'\nnamespace['main'](archive)\n"
    result = subprocess.run([sys.executable, '-I', str(runner)], input=code.encode(), capture_output=True)
    if result.returncode:
        raise RuntimeError('Display contrast deployment failed: ' + result.stderr.decode()[-1600:])
    report = json.loads(result.stdout)
    (PATCH / 'deployment.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    print(json.dumps(report))

if __name__ == '__main__':
    main()
