"""Preserve the current voice-v4 frontend and complete the server question flow."""
import argparse
import base64
import hashlib
import io
import json
import subprocess
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BASE = 'voice-v4-20261030-1'
RELEASE = 'clarification-guard-20261030-2'
PATCH = REPO / ('deploy/online-patches/' + RELEASE)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    runner = REPO.parent / 'tools/vssh_python.py'
    if args.rollback:
        code = (REPO / 'deploy/online-patches/card-packages-20261030-1/rollback.py').read_text(encoding='utf8')
        code = code.replace("previous = ROOT / 'releases/unified-background-20261029-1'", "previous = ROOT / 'releases/" + BASE + "'")
        code = code.replace("current = ROOT / 'releases/card-packages-20261030-1'", "current = ROOT / 'releases/" + RELEASE + "'")
        result = subprocess.run([sys.executable, '-I', str(runner)], input=code.encode(), capture_output=True)
        if result.returncode:
            raise RuntimeError('Rollback failed: ' + result.stderr.decode()[-1200:])
        print(result.stdout.decode().strip())
        return
    old_prefix = 'web/assets/' + BASE + '/'
    prefix = 'web/assets/' + RELEASE + '/'
    changed = {}
    with zipfile.ZipFile(REPO / ('deploy/online-snapshot/frontend-' + BASE + '.zip')) as archive:
        manifest = json.loads(archive.read('manifest.json'))
        for row in manifest['files']:
            path = row['path']
            if path.startswith(old_prefix):
                content = archive.read('objects/' + row['sha256'])
                if path.endswith(('.js', '.css', '.json')):
                    content = content.replace(('assets/' + BASE + '/').encode(), ('assets/' + RELEASE + '/').encode())
                changed[prefix + path[len(old_prefix):]] = content
            elif path in ['web/index.html', 'frontend-headers.conf']:
                changed[path] = archive.read('objects/' + row['sha256']).replace(BASE.encode(), RELEASE.encode())
    control_path = prefix + 'ControlApp-ConfirmationGuard20261030.js'
    control = changed[control_path].decode()
    for before, after in [
        ('onPreviewClarify:t=>{let n=e.host.getSnapshot();', 'onPreviewClarify:t=>{if(e.clarify?.taskId)return;let n=e.host.getSnapshot();'),
        ('s(t),du(e,t),f(g.suggestions??[])', 's(t),g.task?.status!==`awaiting_clarification`&&du(e,t),f(g.suggestions??[])'),
    ]:
        if control.count(before) != 1:
            raise RuntimeError('Current voice frontend question anchor changed')
        control = control.replace(before, after)
    if '[`unknown`,`error`].includes(g.kind)&&g.task?.status!==`awaiting_clarification`' not in control or 't.action!==`delete`' not in control:
        raise RuntimeError('Initial deletion guard was not preserved by the current frontend')
    changed[control_path] = control.encode()
    # Keep the latest app-runtime.js canonical: all its consumers must share contexts.
    if 'app-runtime.js' not in changed[prefix + 'vivic-startup-v59.js'].decode():
        raise RuntimeError('Expected canonical current runtime')
    publication = {'release': RELEASE, 'base': BASE, 'startup': 'vivic-startup-v59.js',
                   'files': [{'path': path, 'sha256': hashlib.sha256(content).hexdigest()} for path, content in changed.items()]}
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('base-manifest.json', json.dumps(manifest))
        archive.writestr('publication-card-packages.json', json.dumps(publication))
        for path, content in changed.items():
            archive.writestr(path, content)
    if not args.apply:
        print(json.dumps({'prepared': True, 'base_files': len(manifest['files']), 'changed_files': len(changed), 'zip_bytes': len(stream.getvalue())}))
        return
    source = (REPO / 'deploy/online-patches/card-packages-20261030-1/apply.py').read_text(encoding='utf8')
    anchor = "['src-BByP9_62.js', 'card-packages.js', 'card-packages.css']"
    verify = ['src-BByP9_62.js', 'card-packages.js', 'card-packages.css', 'ControlApp-ConfirmationGuard20261030.js', 'app-runtime.js', 'voice-composer-v4.js', 'display-contrast-20261030-2.css']
    if source.count(anchor) != 1:
        raise RuntimeError('Checked deployment verifier changed')
    source = source.replace(anchor, repr(verify)).replace("'web/assets/card-packages-20261030-1'", repr('web/assets/' + RELEASE))
    source = source.replace("'/assets/card-packages-20261030-1/'", repr('/assets/' + RELEASE + '/'))
    payload = base64.b64encode(stream.getvalue()).decode()
    code = "import base64\nfrom pathlib import Path\narchive=Path('/opt/vivic-preview-20261025/backend/current-question-flow-" + hashlib.sha256(stream.getvalue()).hexdigest()[:12] + ".zip')\n"
    code += "if archive.exists(): raise RuntimeError('Deployment upload already exists')\narchive.write_bytes(base64.b64decode(" + repr(payload) + "))\n"
    code += "namespace={'__name__':'current_question_flow'}\nexec(compile(" + repr(source) + ",'checked-frontend-deploy','exec'),namespace)\n"
    code += "namespace['BASE']=namespace['ROOT']/'releases/" + BASE + "'\nnamespace['TARGET']=namespace['ROOT']/'releases/" + RELEASE + "'\nnamespace['main'](archive)\n"
    result = subprocess.run([sys.executable, '-I', str(runner)], input=code.encode(), capture_output=True)
    if result.returncode:
        raise RuntimeError('Current question flow deployment failed: ' + result.stderr.decode()[-1600:])
    report = json.loads(result.stdout)
    PATCH.mkdir(parents=True, exist_ok=True)
    (PATCH / 'deployment.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    print(json.dumps(report))

if __name__ == '__main__':
    main()
