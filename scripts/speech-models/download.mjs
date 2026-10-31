import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(await readFile(path.join(root, "apps/web/public/models/sherpaw-manifest.json"), "utf8"));
const args = process.argv.slice(2);
const ids = args.includes("--all") ? manifest.models.map(model => model.id) : args;
if (!ids.length || ids.some(id => !manifest.models.some(model => model.id === id))) {
  console.error("Usage: node scripts/speech-models/download.mjs asr-zh kws-zh-en vad | --all"); process.exit(1);
}
const directory = path.join(root, ".cache/sherpaw-poc/models");
await mkdir(directory, { recursive: true });
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
for (const id of new Set(ids)) {
  const model = manifest.models.find(model => model.id === id);
  const target = path.join(directory, `${id}.bin`);
  const existing = await stat(target).catch(() => null);
  if (existing?.size === model.bytes && await hash(target) === model.sha256) {
    console.log(JSON.stringify({ id, cached: true, bytes: existing.size, sha256: model.sha256 })); continue;
  }
  const partial = `${target}.${process.pid}.part`;
  let file;
  try {
    const response = await fetch(model.url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`${id}: HTTP ${response.status}`);
    file = await open(partial, "wx");
    let bytes = 0, lastPercent = -1;
    const digest = createHash("sha256");
    for await (const chunk of response.body) {
      controller.signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > model.bytes) throw new Error(`${id}: response exceeds expected bytes`);
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Error(`${id}: short disk write`);
        offset += bytesWritten;
      }
      const percent = Math.floor(bytes / model.bytes * 100);
      if (percent >= lastPercent + 10) { console.log(`${id}: ${percent}%`); lastPercent = percent; }
    }
    const sha256 = digest.digest("hex");
    if (bytes !== model.bytes || sha256 !== model.sha256) throw new Error(`${id}: size/SHA-256 mismatch`);
    await file.close(); file = undefined;
    if ((await stat(partial)).size !== model.bytes || await hash(partial) !== model.sha256) throw new Error(`${id}: disk verification failed`);
    await rename(partial, target);
    console.log(JSON.stringify({ id, bytes, sha256, verified: true }));
  } finally {
    await file?.close(); await unlink(partial).catch(() => {});
  }
}
