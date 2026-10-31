import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { stageAndroidDownload } from "./stage-android-download.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run with pnpm package:online.");
const run = (exe, args) => new Promise((resolve, reject) => {
  const child = spawn(exe, args, { cwd: root, stdio: "inherit", windowsHide: true });
  child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Build failed (${code})`)));
});
await stageAndroidDownload(root);
await run(/\.[cm]?js$/i.test(pnpm) ? process.execPath : pnpm,
  [...(/\.[cm]?js$/i.test(pnpm) ? [pnpm] : []), "--filter", "@vivic/web", "build:online"]);
const stage = path.join(root, ".cache", `vivic-online-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await fs.mkdir(path.dirname(stage), { recursive: true });
await fs.mkdir(stage, { recursive: false });
// Source bundle: the target Linux build installs its own native dependencies.
// Never relabel Windows node_modules as a deployable Linux runtime.
const entries = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "LICENSES.md",
  "apps/web/package.json", "apps/web/index.html", "apps/web/vite.config.ts", "apps/web/tsconfig.json", "apps/web/tsconfig.app.json", "apps/web/tsconfig.node.json",
  "apps/web/src", "apps/web/public", "apps/web/dist-online", "apps/local-api/package.json", "apps/local-api/src", "apps/local-api/tsconfig.json",
  "packages", "contrib/mobile-console", "deploy/online", "scripts/online-probe.mjs", "scripts/online-mobile-probe.mjs", "scripts/online-linux-verify.sh"];
for (const entry of entries) {
  const source = path.join(root, entry), target = path.join(stage, entry);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, filter: file => {
    const parts = path.relative(source, file).split(path.sep);
    return !parts.some(name => ["node_modules", ".cache", ".git", "tests", "__tests__", "evidence", "dist-ui"].includes(name)
      || name.startsWith(".env") || /\.(?:log|tsbuildinfo)$/.test(name) || /\.test\.[cm]?[jt]sx?$/.test(name));
  } });
}
await fs.copyFile(path.join(root, "deploy/online/dockerignore"), path.join(stage, ".dockerignore"));
await fs.copyFile(path.join(root, "docs/online-deployment.md"), path.join(stage, "README.md"));
await fs.writeFile(path.join(stage, "release.json"), JSON.stringify({ product: "Vivic Online", createdAt: new Date().toISOString(),
  format: "deployment-source-and-built-web", node: "24.21.0", provider: "stepfun-coding-plan", secretsIncluded: false,
  localLauncherIncluded: false, modelWeightsIncluded: false, liveModelVerified: false,
  linuxVerificationReceipt: "Match this archive SHA256 to the separate target-host verification report; packaging itself does not run Linux." }, null, 2));
const archive = `${stage}.tar.gz`;
await run(process.platform === "win32" ? "tar.exe" : "tar", ["-czf", archive, "-C", stage, "."]);
const digest = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
await fs.writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
console.info(JSON.stringify({ directory: stage, archive, sha256: digest }));
