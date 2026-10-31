import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.VIVIC_SSH_PYTHON || (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe') : 'python3');
const runner = process.env.VIVIC_SSH_RUNNER || resolve(repo, '..', 'tools', 'vssh.py');
const copy = resolve(dirname(runner), 'vcopy.py');
const remote = '/opt/vivic-preview-20261025/backend';
function execute(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: repo, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (args.includes(runner) && result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${program} failed (${result.status})`);
  }
  return result.stdout;
}
function ssh(command) {
  const output = execute(python, ['-I', runner], { input: command + '\n' });
  process.stdout.write(output);
}
if (process.argv[2] === '--rollback') {
  ssh(`bash ${remote}/rollback.sh`);
} else {
  const revision = process.argv[2] || 'HEAD';
  const sha = execute('git', ['rev-parse', '--verify', `${revision}^{commit}`]).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid Git revision');
  const sourcePaths = ['apps/local-api/src', 'packages/contracts/src', 'packages/card-runtime/src'];
  execute('git', ['diff', '--exit-code', sha, '--', ...sourcePaths]);
  const temporary = mkdtempSync(join(tmpdir(), 'vivic-backend-'));
  try {
    const archive = join(temporary, `${sha}.tar`);
    execute('git', ['archive', '--format=tar', `--output=${archive}`, sha, '--', ...sourcePaths]);
    ssh(`install -d -m 700 ${remote} ${remote}/uploads ${remote}/bundles`);
    for (const file of ['Dockerfile', 'deploy.sh', 'rollback.sh']) {
      process.stdout.write(execute(python, ['-I', copy, 'put', join(repo, 'deploy', 'backend', file), `${remote}/${file}`]));
    }
    process.stdout.write(execute(python, ['-I', copy, 'put', archive, `${remote}/uploads/${sha}.tar`]));
    ssh(`bash -n ${remote}/deploy.sh && bash -n ${remote}/rollback.sh && bash ${remote}/deploy.sh ${sha}`);
  } finally {
    const absolute = realpathSync(temporary);
    if (dirname(absolute) !== realpathSync(tmpdir()) || !basename(absolute).startsWith('vivic-backend-')) {
      throw new Error('Refusing unexpected temporary cleanup path');
    }
    rmSync(absolute, { recursive: true, force: true });
  }
}
