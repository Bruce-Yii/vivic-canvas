import { createHash, randomUUID } from "node:crypto";
import { createReadStream, renameSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { gunzipSync } from "node:zlib";

export const LOCAL_DECISION_ARTIFACTS = {
  engine: { name: "llama-b9660-bin-win-vulkan-x64.zip", bytes: 38534318,
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b9660/llama-b9660-bin-win-vulkan-x64.zip",
    sha256: "7c5f7d3830279068dc8078ed0fcf1420b0dcd18f20a78383b083258cb1e4790a" },
  model: { name: "qwen2.5-0.5b-instruct-q4_k_m.gguf", bytes: 491400032,
    url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/9217f5db79a29953eb74d5343926648285ec7e67/qwen2.5-0.5b-instruct-q4_k_m.gguf",
    sha256: "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db" },
} as const;
export type Artifact = { name: string; bytes: number; url: string; sha256: string };
export type EngineArtifact = Artifact & { format: "zip" | "tar.gz"; executable: string; archivePrefix?: string };
const macEngine = (arch: "arm64" | "x64", bytes: number, sha256: string): EngineArtifact => ({
  name: `llama-b9660-bin-macos-${arch}.tar.gz`, bytes, sha256, format: "tar.gz", executable: "llama-server",
  url: `https://github.com/ggml-org/llama.cpp/releases/download/b9660/llama-b9660-bin-macos-${arch}.tar.gz`,
});
/** b9660 is only the existing Qwen smoke-test runtime, not a StartLux Instant engine. */
export function runtimeArtifacts(platform: string = process.platform, arch: string = process.arch) {
  const engine: EngineArtifact | undefined = platform === "win32" && arch === "x64"
    ? { ...LOCAL_DECISION_ARTIFACTS.engine, format: "zip", executable: "llama-server.exe" }
    : platform === "darwin" && arch === "arm64"
      ? macEngine("arm64", 10586814, "eadafe9d562166ea9cefffc1756b31587eaf4717311178586ed32e9adc00036f")
      : platform === "darwin" && arch === "x64"
        ? macEngine("x64", 10876573, "4217a3a8aa77d65a99705c65f68e1e2941143afe3cf4675e3ef9336e850eed8e") : undefined;
  return engine ? { engine, model: LOCAL_DECISION_ARTIFACTS.model } : undefined;
}
const safeName = (name: string) => /^[a-zA-Z0-9_.-]+$/.test(name) && name !== "." && name !== "..";
/** Read the pinned macOS release layout; resolve local dylib aliases into regular files. */
export function readMacEngineArchive(archive: Uint8Array, prefix = "llama-b9660/"): Record<string, Uint8Array> {
  const tar = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 });
  const files: Record<string, Uint8Array> = Object.create(null), links = new Map<string, string>();
  const names = new Set<string>();
  let offset = 0;
  const field = (header: Buffer, start: number, end: number) => header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const sizeText = field(header, 124, 136).trim(), checksumText = field(header, 148, 156).trim();
    if (!/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(checksumText)) throw new Error("engine_archive_header");
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== parseInt(checksumText, 8)) throw new Error("engine_archive_header");
    const size = parseInt(sizeText, 8), name = field(header, 0, 100), type = header[156];
    if (field(header, 345, 500) || !name.startsWith(prefix) || offset + 512 + size > tar.length) throw new Error("engine_archive_path");
    const base = name.slice(prefix.length);
    offset += 512;
    if (type === 53 && !base && size === 0) continue;
    if (!safeName(base) || names.has(base) || names.size >= 256) throw new Error("engine_archive_path");
    names.add(base);
    if (type === 48 || type === 0) files[base] = tar.subarray(offset, offset + size);
    else if (type === 50 && size === 0) {
      const target = field(header, 157, 257);
      if (!safeName(target)) throw new Error("engine_archive_link");
      links.set(base, target);
    } else throw new Error("engine_archive_type");
    offset += Math.ceil(size / 512) * 512;
  }
  for (const [name, target] of links) {
    let resolved = target; const seen = new Set([name]);
    while (links.has(resolved)) {
      if (seen.has(resolved)) throw new Error("engine_archive_link");
      seen.add(resolved); resolved = links.get(resolved)!;
    }
    if (!files[resolved]) throw new Error("engine_archive_link");
    files[name] = files[resolved];
  }
  return files;
}
export async function matchesArtifact(file: string, artifact: Pick<Artifact, "bytes" | "sha256">): Promise<boolean> {
  try {
    if ((await fs.stat(file)).size !== artifact.bytes) return false;
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    return digest.digest("hex") === artifact.sha256;
  } catch { return false; }
}
export async function ensureArtifact(root: string, artifact: Artifact, signal: AbortSignal,
  progress: (bytes: number) => void, fetchImpl = fetch): Promise<void> {
  const target = path.join(root, artifact.name);
  if (await matchesArtifact(target, artifact)) { signal.throwIfAborted(); progress(artifact.bytes); return; }
  signal.throwIfAborted(); await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = path.join(root, `${artifact.name}.${randomUUID()}.part`);
  const output = await fs.open(temporary, "wx", 0o600);
  let response: Response | undefined;
  try {
    response = await fetchImpl(artifact.url, { signal, credentials: "omit", redirect: "follow" });
    if (!response.ok || !response.body) throw new Error("artifact_unavailable");
    const reader = response.body.getReader(), digest = createHash("sha256"); let bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted(); const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length; if (bytes > artifact.bytes) throw new Error("artifact_size");
        digest.update(chunk.value); let offset = 0;
        while (offset < chunk.value.length) { const result = await output.write(chunk.value.subarray(offset)); if (!result.bytesWritten) throw new Error("artifact_write"); offset += result.bytesWritten; }
        progress(bytes);
      }
    } finally { await reader.cancel().catch(() => {}); }
    await output.close(); signal.throwIfAborted();
    if (bytes !== artifact.bytes || digest.digest("hex") !== artifact.sha256) throw new Error("artifact_checksum");
    // No await between cancellation check and commit; an accepted cancel cannot install a late file.
    renameSync(temporary, target); progress(artifact.bytes);
  } finally { await output.close().catch(() => {}); await fs.rm(temporary, { force: true }).catch(() => {}); }
}
/** Extract only a previously verified engine archive into its dedicated installation directory. */
export async function installEngine(root: string, signal: AbortSignal, engine: EngineArtifact = runtimeArtifacts()!.engine) {
  const archive = path.join(root, engine.name);
  if (!await matchesArtifact(archive, engine)) throw new Error("engine_checksum");
  signal.throwIfAborted(); const data = await fs.readFile(archive);
  const files = engine.format === "zip" ? unzipSync(data) : readMacEngineArchive(data, engine.archivePrefix);
  if (Object.keys(files).length > 256) throw new Error("engine_archive_limit");
  const destination = path.join(root, "engine"); await fs.mkdir(destination, { recursive: true });
  const receipt: Record<string, { bytes: number; sha256: string }> = {};
  let expanded = 0;
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    if (!safeName(name)) throw new Error("engine_archive_path");
    expanded += data.length; if (expanded > 512 * 1024 * 1024) throw new Error("engine_archive_limit");
    signal.throwIfAborted(); await fs.writeFile(path.join(destination, name), data, { mode: 0o755 });
    if (engine.format === "tar.gz") await fs.chmod(path.join(destination, name), 0o755);
    receipt[name] = { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  }
  if (!receipt[engine.executable]) throw new Error("engine_missing");
  signal.throwIfAborted(); await fs.writeFile(path.join(destination, "receipt.json"), JSON.stringify({ artifactSha256: engine.sha256, files: receipt }), { mode: 0o600 });
}
export async function installedEngine(root: string, engine: EngineArtifact = runtimeArtifacts()!.engine) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, "engine", "receipt.json"), "utf8"));
    // Keep existing Windows installations usable; new receipts bind the platform archive.
    const receipt = (raw.artifactSha256 ? raw.artifactSha256 === engine.sha256 ? raw.files : undefined
      : engine.format === "zip" ? raw : undefined) as Record<string, { bytes: number; sha256: string }> | undefined;
    if (!receipt?.[engine.executable] || Object.keys(receipt).length > 256) return false;
    for (const [name, record] of Object.entries(receipt)) {
      if (!safeName(name) || !await matchesArtifact(path.join(root, "engine", name), record)) return false;
    }
    return true;
  } catch { return false; }
}
