import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const verifyOnly = args.includes("--verify-only");
const arch = value("--arch") ?? process.arch;
if (!["x64", "arm64"].includes(arch) || !verifyOnly && process.platform !== "linux") throw new Error("Connector installation supports Linux x64/arm64. Other hosts may use --verify-only --arch x64|arm64.");
const root = path.resolve(value("--dest") ?? "/opt/vivic/connectors");
const manifest = JSON.parse(await fs.readFile(new URL("./connector-clis.json", import.meta.url), "utf8"));
const temporary = await fs.mkdtemp(path.join(tmpdir(), "vivic-connector-install-"));
try {
  for (const [name, pkg] of Object.entries(manifest)) {
    const artifact = pkg[`linux-${arch}`];
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || Number(response.headers.get("content-length")) > 128 * 1024 * 1024) throw new Error(`${name}: download failed (${response.status}).`);
    const reader = response.body.getReader(); const chunks = []; let length = 0;
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 128 * 1024 * 1024) throw new Error("Archive exceeds download bound."); chunks.push(chunk.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const archive = Buffer.concat(chunks, length);
    const algorithm = artifact.sha256 ? "sha256" : "sha512";
    const actual = createHash(algorithm).update(archive).digest(algorithm === "sha256" ? "hex" : "base64");
    if (actual !== artifact[algorithm]) throw new Error(`${name}: checksum mismatch.`);
    const file = path.join(temporary, `${name}.tar.gz`); await fs.writeFile(file, archive);
    // Only one audited regular-file member is streamed out; no archive paths are written.
    const binary = execFileSync(process.platform === "win32" ? "tar.exe" : "tar", ["-xOf", file, pkg.member], { windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    if (binary.subarray(0, 4).toString("hex") !== "7f454c46" || binary[4] !== 2 || binary.readUInt16LE(18) !== (arch === "x64" ? 62 : 183)) throw new Error(`${name}: unexpected native binary architecture.`);
    const programOffset = Number(binary.readBigUInt64LE(32)), programSize = binary.readUInt16LE(54), programCount = binary.readUInt16LE(56);
    if (programOffset + programSize * programCount > binary.length) throw new Error(`${name}: invalid ELF program table.`);
    for (let index = 0; index < programCount; index++) if (binary.readUInt32LE(programOffset + programSize * index) === 3) throw new Error(`${name}: release now requires a dynamic loader; review runtime dependencies before updating.`);
    const destination = path.join(root, name, pkg.version, `${name === "lark" ? "lark" : "wecom"}-cli`);
    const dependencies = [...new Set(binary.toString("latin1").match(/(?:libc|libgcc_s|libstdc\+\+|libssl|libcrypto|libpthread|libdl|libm)\.so(?:\.[0-9]+)*/g) ?? [])];
    if (!verifyOnly) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, binary, { mode: 0o755 }); await fs.chmod(destination, 0o755);
      // No inherited keys, auth sidecars, proxy headers, HOME or account cache.
      const version = execFileSync(destination, ["--version"], { timeout: 15_000, encoding: "utf8", env: {
        PATH: "/usr/local/bin:/usr/bin:/bin", HOME: temporary, TMPDIR: temporary, XDG_CONFIG_HOME: temporary,
        LARKSUITE_CLI_CONFIG_DIR: temporary, WECOM_CLI_CONFIG_DIR: temporary,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1", NO_COLOR: "1",
      } });
      if (!version.includes(pkg.version)) throw new Error(`${name}: version smoke failed.`);
    }
    console.log(JSON.stringify({ connector: name, version: pkg.version, platform: `linux-${arch}`, integrityVerified: true, staticElf: true, nativeVersionExecuted: !verifyOnly, dependencies, destination: verifyOnly ? undefined : destination }));
  }
} finally {
  if (path.dirname(temporary) === path.resolve(tmpdir()) && path.basename(temporary).startsWith("vivic-connector-install-")) await fs.rm(temporary, { recursive: true, force: true });
}
