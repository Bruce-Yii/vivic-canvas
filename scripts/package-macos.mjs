import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { stageAndroidDownload } from "./stage-android-download.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// A Windows/Linux deployment can contain the wrong sharp/esbuild binaries.
// Build each architecture on macOS with dependencies installed by that Node.
if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
  throw new Error("Build this package on macOS arm64 or x64, using a matching Node and a fresh locked dependency install.");
}
const nodeVersion = "24.21.0";
// https://nodejs.org/dist/v24.21.0/SHASUMS256.txt (checked 2026-10-23).
const archiveSha = {
  arm64: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
  x64: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
}[process.arch];
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output")) throw new Error("Usage: pnpm package:macos [--output <new-directory>]");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const stage = args.length ? path.resolve(root, args[1]) : path.join(root, ".cache", `vivic-macos-${process.arch}-${stamp}`);
if (await fs.lstat(stage).then(() => true, () => false)) throw new Error("Package output already exists; choose a new directory.");
if (await fs.lstat(`${stage}.zip`).then(() => true, () => false)) throw new Error("Package archive already exists; choose a new directory.");
const api = path.join(stage, "apps/local-api");
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run with pnpm package:macos (or pnpm exec node scripts/package-macos.mjs).");
const run = (exe, commandArgs, cwd = root) => new Promise((resolve, reject) => {
  const child = spawn(exe, commandArgs, { cwd, stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Build step failed (${code}): ${path.basename(exe)}`)));
});
// pnpm 12 may expose a native executable rather than a JavaScript launcher.
const runPnpm = commandArgs => /\.[cm]?js$/i.test(pnpm)
  ? run(process.execPath, [pnpm, ...commandArgs]) : run(pnpm, commandArgs);
const sha256 = buffer => createHash("sha256").update(buffer).digest("hex");

await stageAndroidDownload(root);
await runPnpm(["build"]);
await runPnpm(["--filter", "@vivic/local-api", "deploy", "--prod", "--config.node-linker=hoisted", api]);
await fs.cp(path.join(root, "apps/web/dist"), path.join(stage, "apps/web/dist"), { recursive: true });
const archiveName = `node-v${nodeVersion}-darwin-${process.arch}.tar.gz`;
const archivePath = path.join(root, ".cache", archiveName);
await fs.mkdir(path.dirname(archivePath), { recursive: true });
let archive = await fs.readFile(archivePath).catch(() => null);
if (!archive || sha256(archive) !== archiveSha) {
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Official Node distribution unavailable (${response.status}).`);
  archive = Buffer.from(await response.arrayBuffer());
  if (sha256(archive) !== archiveSha) throw new Error("Node distribution checksum mismatch.");
  await fs.writeFile(archivePath, archive);
}
const unpack = path.join(stage, ".node-unpack");
await fs.mkdir(unpack);
await run("/usr/bin/tar", ["-xzf", archivePath, "-C", unpack]);
const nodeDirectory = path.join(unpack, `node-v${nodeVersion}-darwin-${process.arch}`);
const node = await fs.readFile(path.join(nodeDirectory, "bin/node"));
await fs.mkdir(path.join(stage, "runtime"));
await fs.writeFile(path.join(stage, "runtime/node"), node, { mode: 0o755 });
await fs.copyFile(path.join(nodeDirectory, "LICENSE"), path.join(stage, "runtime/NODE_LICENSE.txt"));
await fs.writeFile(path.join(stage, "runtime/node.sha256"), `${sha256(node)}  runtime/node\n`);
await fs.rm(unpack, { recursive: true }); // Only this fresh package's extraction directory.
for (const name of await fs.readdir(path.join(root, "scripts/macos"))) {
  await fs.copyFile(path.join(root, "scripts/macos", name), path.join(stage, name));
  if (name.endsWith(".command")) await fs.chmod(path.join(stage, name), 0o755);
}
await fs.writeFile(path.join(stage, "VIVIC-NOTICE.txt"), "Vivic preview distribution. Project rights remain with the project authors. Third-party licenses accompany their packages in apps/local-api/node_modules. Node.js license is in runtime/NODE_LICENSE.txt. This preview has not been Apple notarized.\n");
await fs.copyFile(path.join(root, "LICENSES.md"), path.join(stage, "LICENSES.md"));
await fs.writeFile(path.join(stage, "release.json"), JSON.stringify({
  product: "Vivic", createdAt: new Date().toISOString(), nodeVersion,
  nodeArchiveSha256: archiveSha, nodeSha256: sha256(node), platform: `darwin-${process.arch}`,
  nativeDependenciesVerified: false, modelIncluded: false, appleNotarized: false,
}, null, 2));
await fs.writeFile(path.join(stage, "README.txt"), `Vivic macOS ${process.arch}\n\nOpen Install-Vivic.command to install a new per-user Vivic.app in ~/Applications.\nExisting apps are preserved. Start-Vivic.command can also run this extracted package.\nThe launcher opens http://127.0.0.1:18787/launcher in your browser.\nClosing the browser does not stop Vivic. Run Stop-Vivic.command to stop this package and its owned model.\nFor another port: ./Start-Vivic.command --port 18788 (each address has separate browser storage).\nNo model weights or credentials are included. Configure connections on the computer.\nOnly prepare a local model after checking its platform support and download size in the launcher.\nLogs are runtime.out.log and runtime.err.log. Other apps on occupied ports are never stopped.\nDo not redistribute a folder after running it: it can contain local session files.\nThis is an unsigned, unnotarized preview. If macOS blocks it, review the package and use the normal macOS Privacy & Security approval flow. No Gatekeeper bypass is installed.\n\nInstalled apps contain Start/Stop commands in Contents/Resources/package.\n`);

// Exercise the deployed architecture-specific modules with the bundled Node.
// This is deliberately after deploy, not merely a build of the source tree.
await run(path.join(stage, "runtime/node"), ["--import", "tsx", "--input-type=module", "-e",
  `import sharp from 'sharp'; import { transformSync } from 'esbuild';
   if (process.platform !== 'darwin' || process.arch !== ${JSON.stringify(process.arch)}) throw new Error('Wrong bundled runtime');
   await sharp({create:{width:1,height:1,channels:4,background:'#000'}}).png().toBuffer();
   transformSync('const answer: number = 42', {loader:'ts'});
   console.info('Deployed native dependencies passed');`], api);
const receipt = JSON.parse(await fs.readFile(path.join(stage, "release.json"), "utf8"));
receipt.nativeDependenciesVerified = true;
await fs.writeFile(path.join(stage, "release.json"), JSON.stringify(receipt, null, 2));
const zip = `${stage}.zip`;
await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", "--sequesterRsrc", stage, zip]);
const zipSha = sha256(await fs.readFile(zip));
await fs.writeFile(`${zip}.sha256`, `${zipSha}  ${path.basename(zip)}\n`);
console.info(JSON.stringify({ directory: stage, archive: zip, sha256: zipSha, platform: receipt.platform }));
