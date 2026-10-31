import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { stageAndroidDownload } from "./stage-android-download.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build this Windows x64 package on Windows x64.");
const nodeVersion = "24.21.0";
const archiveSha = "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const stage = path.join(root, ".cache", `vivic-windows-${stamp}`);
const api = path.join(stage, "apps", "local-api");
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run with pnpm package:windows.");
const run = (exe, args, cwd = root) => new Promise((resolve, reject) => {
  const child = spawn(exe, args, { cwd, stdio: "inherit", windowsHide: true });
  child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Build step failed (${code})`)));
});
const runPnpm = args => run(pnpm.endsWith(".exe") ? pnpm : process.execPath, [...(pnpm.endsWith(".exe") ? [] : [pnpm]), ...args]);
await stageAndroidDownload(root);
await runPnpm(["build"]);
await runPnpm(["--filter", "@vivic/local-api", "deploy", "--prod", "--config.node-linker=hoisted", api]);
await fs.cp(path.join(root, "apps/web/dist"), path.join(stage, "apps/web/dist"), { recursive: true });
const archivePath = path.join(root, ".cache", `node-v${nodeVersion}-win-x64.zip`);
let archive = await fs.readFile(archivePath).catch(() => null);
if (!archive || createHash("sha256").update(archive).digest("hex") !== archiveSha) {
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-win-x64.zip`, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error("Node distribution unavailable");
  archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== archiveSha) throw new Error("Node distribution checksum mismatch");
  await fs.writeFile(archivePath, archive);
}
const require = createRequire(path.join(root, "apps/local-api/package.json"));
const { unzipSync } = require("fflate");
const files = unzipSync(archive);
await fs.mkdir(path.join(stage, "runtime"), { recursive: true });
const node = files[`node-v${nodeVersion}-win-x64/node.exe`];
if (!node) throw new Error("Node executable missing");
await fs.writeFile(path.join(stage, "runtime/node.exe"), node);
await fs.writeFile(path.join(stage, "runtime/NODE_LICENSE.txt"), files[`node-v${nodeVersion}-win-x64/LICENSE`]);
for (const name of await fs.readdir(path.join(root, "scripts/windows"))) await fs.copyFile(path.join(root, "scripts/windows", name), path.join(stage, name));
await fs.writeFile(path.join(stage, "VIVIC-NOTICE.txt"), "Vivic preview distribution. Project rights remain with the project authors. Third-party licenses accompany their packages in apps/local-api/node_modules. Node.js license is in runtime/NODE_LICENSE.txt.\n");
await fs.copyFile(path.join(root, "LICENSES.md"), path.join(stage, "LICENSES.md"));
await fs.writeFile(path.join(stage, "release.json"), JSON.stringify({ product: "Vivic", createdAt: new Date().toISOString(), nodeVersion, nodeArchiveSha256: archiveSha,
  nodeSha256: createHash("sha256").update(node).digest("hex"), platform: "win32-x64", modelIncluded: false }, null, 2));
await fs.writeFile(path.join(stage, "README.txt"), "Vivic Windows x64\r\n\r\nDouble-click Start-Vivic.cmd to open the local launcher at http://127.0.0.1:18787/launcher.\r\nOpen the canvas immediately, or prepare and start the optional local decision model.\r\nClosing the browser does not stop the local service. Use Stop-Vivic.cmd to release it and its owned model.\r\nInstall-Vivic.cmd copies this folder to a new LocalAppData directory and creates desktop shortcuts; existing shortcuts are preserved.\r\nFor an isolated install, run powershell -File Install-Vivic.ps1 -Destination <new-folder> -NoShortcuts.\r\nFor another port, run powershell -File Start-Vivic.ps1 -Port 18788; canvas storage is separate for each address.\r\nStartLux profiles are selected by memory; the launcher shows each download size. Python and the engine are prepared privately on first use. Optional local Kokoro voice is about 400 MB plus its runtime. CPU inference only; uncertain results fall back to the original flow.\r\nNo model credentials are included. Mobile relay needs a separately provisioned private ~/.vivic/mobile-relay.json.\r\nIf startup fails, inspect runtime.err.log and retry. Occupied ports are never stopped automatically.\r\nDo not redistribute a folder after running it: it can contain local session files.\r\n");
// The hoisted deployment is ordinary files; no administrator permission is needed to extract it.
const zip = `${stage}.zip`;
await run("tar.exe", ["-a", "-cf", zip, "-C", stage, "."]);
const zipSha = createHash("sha256").update(await fs.readFile(zip)).digest("hex");
await fs.writeFile(`${zip}.sha256`, `${zipSha}  ${path.basename(zip)}\n`);
console.info(JSON.stringify({ directory: stage, archive: zip, sha256: zipSha }));
