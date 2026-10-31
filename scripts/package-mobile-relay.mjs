import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run with pnpm package:relay");
const release = path.join(root, ".cache", `mobile-relay-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const run = (exe, args) => new Promise((resolve, reject) => {
  const child = spawn(exe, args, { cwd: root, stdio: "inherit", windowsHide: true });
  child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Build step failed (${code})`)));
});
const runPnpm = args => run(pnpm.endsWith(".exe") ? pnpm : process.execPath, [...(pnpm.endsWith(".exe") ? [] : [pnpm]), ...args]);
await runPnpm(["--filter", "@vivic/web", "build:mobile"]);
await runPnpm(["--filter", "@vivic/mobile-console-prototype", "deploy", "--prod", "--config.node-linker=hoisted", release]);
const require = createRequire(path.join(root, "apps/local-api/package.json"));
const { build } = createRequire(require.resolve("tsx/package.json"))("esbuild");
await build({ entryPoints: [path.join(root, "contrib/mobile-console/server.ts")], outfile: path.join(release, "server.mjs"),
  bundle: true, platform: "node", format: "esm", packages: "external", target: "node24" });
await fs.cp(path.join(root, "contrib/mobile-console/dist-ui"), path.join(release, "ui"), { recursive: true });
await fs.rm(path.join(release, "ui/computer.html"), { force: true });
await fs.copyFile(path.join(root, "LICENSES.md"), path.join(release, "LICENSES.md"));
await run("tar", ["-czf", `${release}.tar.gz`, "-C", release, "."]);
console.info(JSON.stringify({ directory: release, archive: `${release}.tar.gz`, admissionSecretIncluded: false }));
