import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(repo, 'deploy', 'online-patches');
const python = process.env.VIVIC_SSH_PYTHON || (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe') : 'python3');
const runner = process.env.VIVIC_SSH_RUNNER || resolve(repo, '..', 'tools', 'vssh.py');
const known = readdirSync(destination, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name);
let since = 0;
try { since = JSON.parse(readFileSync(join(destination, 'SYNC_STATE.json'), 'utf8')).sync_epoch; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const payload = Buffer.from(JSON.stringify({ known, since })).toString('base64');
const script = readFileSync(join(destination, 'sync.sh'), 'utf8').replaceAll('\r\n', '\n');
const command = `bash -s -- ${payload} <<'VIVIC_SYNC_SH'\n${script}\nVIVIC_SYNC_SH\n`;
const temporary = mkdtempSync(join(tmpdir(), 'vivic-patches-'));
try {
  const result = spawnSync(python, ['-I', runner], {
    input: command, maxBuffer: 64 * 1024 * 1024, cwd: repo,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Remote patch export failed (exit ${result.status})`);
  const archive = join(temporary, 'patches.tar');
  writeFileSync(archive, result.stdout);
  const imported = spawnSync(python, ['-I', join(destination, 'import.py'), archive, destination], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  if (imported.error) throw imported.error;
  if (imported.status !== 0) throw new Error(imported.stderr || 'Patch import failed');
  const metadata = JSON.parse(imported.stdout);
  writeFileSync(join(destination, 'RUNNING_CONTAINER.txt'),
    `${metadata.image}\n${metadata.frontend}\ncontainer=${metadata.container}\nsynced_at=${metadata.synced_at}\n`);
  writeFileSync(join(destination, 'SYNC_STATE.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log(JSON.stringify({ imported: metadata.releases, frontend: metadata.frontend }, null, 2));
} finally {
  const absolute = realpathSync(temporary);
  if (dirname(absolute) !== realpathSync(tmpdir()) || !basename(absolute).startsWith('vivic-patches-')) {
    throw new Error('Refusing unexpected temporary cleanup path');
  }
  rmSync(absolute, { recursive: true, force: true });
}
