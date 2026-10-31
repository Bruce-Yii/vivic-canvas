/** Generate authored feedback files; never open an audio device or persist credentials.
 * node scripts/generate-stepfun-feedback.mjs --key-stdin
 * Input: one line containing the StepFun Plan key. Uses the Plan endpoint only.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const clips = [
  ['checking', '我看看'], ['waiting', '稍等'], ['okay', '好的'],
  ['organizing', '我来帮你整理一下'], ['planning', '我来安排一下'],
  ['working', '正在处理，请稍等'], ['done', '已经处理好了'],
  ['saved', '已保存'], ['cancelled', '已取消本次请求'],
  ['undone', '已撤销'], ['ready', '准备好了'],
  ['connected', '连接成功'], ['disconnected', '连接已断开'],
  ['retry', '刚才没有成功，请再试一次'],
  ['clarify', '你想调整哪一张卡片'], ['empty', '这里还没有卡片'],
];

async function main() {
  if (!process.argv.includes('--key-stdin')) throw new Error('Use --key-stdin; keys must not be command-line arguments.');
  const input = createInterface({ input: process.stdin, terminal: false });
  let key = '';
  for await (const line of input) { key = line.trim(); input.close(); break; }
  if (!key || key.length > 1000) throw new Error('Missing or invalid key.');
  const output = fileURLToPath(new URL('../apps/web/public/voice-feedback/stepfun/', import.meta.url));
  await mkdir(output, { recursive: true });
  const files = [];
  for (const [id, text] of clips) {
    const response = await fetch('https://api.stepfun.com/step_plan/v1/audio/speech', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ model: 'stepaudio-2.5-tts', input: text, voice: 'wenrounvsheng', speed: 1, response_format: 'mp3' }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Plan speech rejected (HTTP ${response.status}); no alternate billing route or retry.`); }
    if (!['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes((response.headers.get('content-type') ?? '').split(';')[0])) {
      await response.body?.cancel(); throw new Error('Unexpected speech format.');
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('Speech file too large.'); chunks.push(chunk); }
    const audio = Buffer.concat(chunks);
    if (audio.length < 100 || !(audio.subarray(0, 3).toString() === 'ID3' || audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)) throw new Error('Invalid MP3 signature.');
    await writeFile(path.join(output, `${id}.mp3`), audio);
    files.push({ id, text, file: `${id}.mp3`, bytes: size, sha256: createHash('sha256').update(audio).digest('hex') });
    console.log(`Generated ${id}: ${size} bytes`);
  }
  key = '';
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({
    provider: 'StepFun', model: 'stepaudio-2.5-tts', voice: 'wenrounvsheng', speed: 1,
    generatedAt: new Date().toISOString(), source: 'https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio',
    generation: 'Authored generic Chinese phrases; Plan endpoint; file generation only; no playback or voice cloning.', files,
  }, null, 2) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error instanceof Error && /^(Use|Missing|Plan|Unexpected|Speech|Invalid)/.test(error.message) ? error.message : 'Speech generation failed; upstream details omitted.');
  process.exitCode = 1;
});
