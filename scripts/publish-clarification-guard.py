"""Keep server-owned clarification on its task in the current packaged frontend."""
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
BASE = 'display-contrast-20261030-1'
RELEASE = 'clarification-guard-20261030-1'
ASSETS = 'web/assets/card-packages-20261030-1/'
PATCH = REPO / ('deploy/online-patches/' + RELEASE)

def main():
    global BASE, RELEASE, PATCH
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--complete-flow', action='store_true')
    args = parser.parse_args()
    if args.complete_flow:
        BASE = 'clarification-guard-20261030-1'
        RELEASE = 'clarification-guard-20261030-2'
        PATCH = REPO / ('deploy/online-patches/' + RELEASE)
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
    with zipfile.ZipFile(REPO / ('deploy/online-snapshot/frontend-' + BASE + '.zip')) as archive:
        manifest = json.loads(archive.read('manifest.json'))
        files = {row['path']: row for row in manifest['files']}
        def read(path):
            return archive.read('objects/' + files[path]['sha256']).decode()
        index = read('web/index.html')
        headers = read('frontend-headers.conf')
        old_startup = 'vivic-startup-confirmation-20261030.js' if args.complete_flow else 'vivic-startup-v54.js'
        old_runtime = 'app-runtime-confirmation-20261030.js' if args.complete_flow else 'app-runtime-v54.js'
        old_control = 'ControlApp-ConfirmationGuard20261030.js' if args.complete_flow else 'ControlApp-TutorialEntry20261029.js'
        startup = read(ASSETS + old_startup)
        runtime = read(ASSETS + old_runtime)
        control = read(ASSETS + old_control)
    if args.complete_flow:
        before = 'onPreviewClarify:t=>{let n=e.host.getSnapshot();'
        after = 'onPreviewClarify:t=>{if(e.clarify?.taskId)return;let n=e.host.getSnapshot();'
        if control.count(before) != 1:
            raise RuntimeError('Expected preview branch changed')
        control = control.replace(before, after)
        before = 's(t),du(e,t),f(g.suggestions??[])'
        after = 's(t),g.task?.status!==`awaiting_clarification`&&du(e,t),f(g.suggestions??[])'
        if control.count(before) != 1:
            raise RuntimeError('Expected task feedback branch changed')
        control = control.replace(before, after)
    else:
        old = re.search(r'\[`unknown`,`clarify`,`error`\]\.includes\(([A-Za-z_$][A-Za-z0-9_$]*)\.kind\)', control)
        if not old:
            raise RuntimeError('Expected legacy chooser branch not found')
        variable = old.group(1)
        replacement = '[`unknown`,`error`].includes(' + variable + '.kind)&&' + variable + '.task?.status!==`awaiting_clarification`'
        control = control[:old.start()] + replacement + control[old.end():]
        tail_start = old.start() + len(replacement)
        choice = re.search(r'if\(([A-Za-z_$][A-Za-z0-9_$]*)\.kind===`clarify`\)', control[tail_start:tail_start+400])
        if not choice:
            raise RuntimeError('Expected local picker branch not found')
        start, end = tail_start + choice.start(), tail_start + choice.end()
        control = control[:start] + 'if(' + choice.group(1) + '.kind===`clarify`&&' + choice.group(1) + '.action!==`delete`)' + control[end:]
    suffix = '-2' if args.complete_flow else ''
    control_name = 'ControlApp-ConfirmationGuard20261030' + suffix + '.js'
    runtime_name = 'app-runtime-confirmation-20261030' + suffix + '.js'
    startup_name = 'vivic-startup-confirmation-20261030' + suffix + '.js'
    if runtime.count(old_control) != 2 or startup.count(old_runtime) != 1 or index.count(old_startup) != 1:
        raise RuntimeError('Current startup route changed')
    runtime = runtime.replace(old_control, control_name)
    startup = startup.replace(old_runtime, runtime_name)
    index = index.replace(old_startup, startup_name).replace('content="' + BASE + '"', 'content="' + RELEASE + '"')
    changed = {ASSETS + control_name: control.encode(), ASSETS + runtime_name: runtime.encode(), ASSETS + startup_name: startup.encode(),
               'web/index.html': index.encode(), 'frontend-headers.conf': headers.replace(BASE, RELEASE).encode()}
    publication = {'release': RELEASE, 'base': BASE, 'startup': startup_name,
                   'files': [{'path': path, 'sha256': hashlib.sha256(data).hexdigest()} for path, data in changed.items()]}
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('base-manifest.json', json.dumps(manifest))
        archive.writestr('publication-card-packages.json', json.dumps(publication))
        for path, data in changed.items():
            archive.writestr(path, data)
    if not args.apply:
        print(json.dumps({'prepared': True, 'base_files': len(manifest['files']), 'changed_files': len(changed), 'zip_bytes': len(stream.getvalue())}))
        return
    source = (REPO / 'deploy/online-patches/card-packages-20261030-1/apply.py').read_text(encoding='utf8')
    anchor = "['src-BByP9_62.js', 'card-packages.js', 'card-packages.css']"
    source = source.replace(anchor, repr(['src-BByP9_62.js', 'card-packages.js', 'card-packages.css', control_name, runtime_name, startup_name, 'display-contrast-20261030-2.css']))
    payload = base64.b64encode(stream.getvalue()).decode()
    code = "import base64\nfrom pathlib import Path\narchive=Path('/opt/vivic-preview-20261025/backend/clarification-guard-" + hashlib.sha256(stream.getvalue()).hexdigest()[:12] + ".zip')\n"
    code += "if archive.exists(): raise RuntimeError('Deployment upload already exists')\narchive.write_bytes(base64.b64decode(" + repr(payload) + "))\n"
    code += "namespace={'__name__':'clarification_guard_deploy'}\nexec(compile(" + repr(source) + ",'checked-frontend-deploy','exec'),namespace)\n"
    code += "namespace['BASE']=namespace['ROOT']/'releases/" + BASE + "'\nnamespace['TARGET']=namespace['ROOT']/'releases/" + RELEASE + "'\nnamespace['main'](archive)\n"
    result = subprocess.run([sys.executable, '-I', str(runner)], input=code.encode(), capture_output=True)
    if result.returncode:
        raise RuntimeError('Clarification guard deployment failed: ' + result.stderr.decode()[-1600:])
    report = json.loads(result.stdout)
    PATCH.mkdir(parents=True, exist_ok=True)
    (PATCH / 'deployment.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    print(json.dumps(report))

if __name__ == '__main__':
    main()
