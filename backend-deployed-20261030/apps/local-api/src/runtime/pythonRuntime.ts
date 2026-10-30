import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import platformArtifacts from "./platform-artifacts.json" with { type: "json" };
import { ensureArtifact, installEngine, installedEngine, type EngineArtifact } from "./artifacts.js";

export const PYTHON_VERSION = "3.12.15";
export const STARTLUX_SOURCE = { name: "startlux-source.zip", bytes: 110834738, sha256: "a4c1109f1d899ea03b37faa79395f7373c2e006abbb7dadc88be8fd4ea549365",
  url: "https://codeload.github.com/StartLuxLabs/StartLux-Decision/zip/83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01" };
export const SOURCE_PREFIX = "StartLux-Decision-83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01/";
export function localRuntimeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const names = ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG"];
  return { ...Object.fromEntries(names.filter(n => process.env[n] !== undefined).map(n => [n, process.env[n]])),
    PYTHONUTF8: "1", PYTHONNOUSERSITE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", ...extra };
}
/** No shell, inherited API keys, console output, global installation, or user-level uv config. */
export function runOwned(executable: string, args: string[], signal: AbortSignal, env: NodeJS.ProcessEnv, cwd?: string) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(executable, args, { env, cwd, windowsHide: true, stdio: "ignore" });
    let force: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { child.kill(); force = setTimeout(() => child.kill("SIGKILL"), 1000); };
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    const finish = (error?: Error) => { signal.removeEventListener("abort", abort); clearTimeout(force); if (error) reject(error); else resolve(); };
    child.once("error", () => finish(new Error("runtime_process_unavailable")));
    child.once("close", code => finish(signal.aborted ? new Error("runtime_cancelled") : code === 0 ? undefined : new Error("runtime_process_failed")));
  });
}
export function pinnedEngine(platform = process.platform, arch = process.arch): EngineArtifact | undefined {
  const name = platform === "win32" && arch === "x64" ? "llama-b11550-bin-win-cpu-x64.zip"
    : platform === "darwin" && ["arm64", "x64"].includes(arch) ? `llama-b11550-bin-macos-${arch}.tar.gz` : undefined;
  const a = platformArtifacts.find(a => a.name === name);
  return a ? { ...a, format: platform === "win32" ? "zip" : "tar.gz", executable: platform === "win32" ? "llama-server.exe" : "llama-server", archivePrefix: "llama-b11550/" } : undefined;
}
function pinnedUv(platform = process.platform, arch = process.arch): EngineArtifact | undefined {
  const name = platform === "win32" && arch === "x64" ? "uv-x86_64-pc-windows-msvc.zip"
    : platform === "darwin" && arch === "arm64" ? "uv-aarch64-apple-darwin.tar.gz"
      : platform === "darwin" && arch === "x64" ? "uv-x86_64-apple-darwin.tar.gz" : undefined;
  const a = platformArtifacts.find(a => a.name === name);
  return a ? { ...a, format: platform === "win32" ? "zip" : "tar.gz", executable: platform === "win32" ? "uv.exe" : "uv", archivePrefix: name?.replace(".tar.gz", "/") } : undefined;
}
export class LocalPythonRuntime {
  readonly root: string;
  readonly python: string;
  readonly source: string;
  constructor(root: string) {
    this.root = root;
    this.python = path.join(root, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    this.source = path.join(root, "source");
  }
  private async lockHash() { return createHash("sha256").update(await fs.readFile(fileURLToPath(new URL("./python-runtime.lock", import.meta.url)))).digest("hex"); }
  async ready() {
    try { const receipt = JSON.parse(await fs.readFile(path.join(this.root, "python-receipt.json"), "utf8"));
      return receipt.python === PYTHON_VERSION && receipt.lock === await this.lockHash() && (await fs.stat(this.python)).isFile();
    } catch { return false; }
  }
  async prepare(signal: AbortSignal, progress: (bytes: number) => void = () => {}) {
    if (await this.ready()) { signal.throwIfAborted(); return; }
    const uv = pinnedUv(); if (!uv) throw new Error("unsupported_platform");
    const uvRoot = path.join(this.root, "uv");
    await ensureArtifact(uvRoot, uv, signal, progress);
    if (!await installedEngine(uvRoot, uv)) await installEngine(uvRoot, signal, uv);
    const executable = path.join(uvRoot, "engine", uv.executable);
    const env = localRuntimeEnv({ UV_NO_CONFIG: "1", UV_PYTHON_INSTALL_DIR: path.join(this.root, "python"), UV_CACHE_DIR: path.join(this.root, "dependency-cache"), UV_NO_PROGRESS: "1" });
    await runOwned(executable, ["python", "install", PYTHON_VERSION, "--no-bin", "--no-registry", "--no-config"], signal, env);
    await runOwned(executable, ["venv", "--allow-existing", "--python", PYTHON_VERSION, "--managed-python", "--no-config", path.join(this.root, "venv")], signal, env);
    await runOwned(executable, ["pip", "install", "--python", this.python, "--require-hashes", "--only-binary", ":all:", "--index-url", "https://pypi.org/simple", "--no-config", "-r", fileURLToPath(new URL("./python-runtime.lock", import.meta.url))], signal, env);
    await runOwned(this.python, ["-c", "import sys,transformers,aiohttp,sherpa_onnx,numpy,jinja2; assert sys.version_info[:3]==(3,12,15); assert transformers.__version__=='5.8.0'; assert sherpa_onnx.__version__=='1.12.32'"], signal, env);
    signal.throwIfAborted(); await fs.writeFile(path.join(this.root, "python-receipt.json"), JSON.stringify({ python: PYTHON_VERSION, lock: await this.lockHash() }), { mode: 0o600 });
  }
}
export async function extractStartluxSource(archive: string, destination: string, signal: AbortSignal) {
  const files = unzipSync(await fs.readFile(archive)); const receipt: Record<string, {bytes:number;sha256:string}> = {};
  for (const [raw, data] of Object.entries(files)) {
    if (!raw.startsWith(SOURCE_PREFIX)) throw new Error("source_archive_path");
    const name = raw.slice(SOURCE_PREFIX.length);
    if (!(name.startsWith("startlux_decide/") && name.endsWith(".py")) && !["LICENSE", "README.md", "pyproject.toml"].includes(name)) continue;
    if (name.split("/").some(s => !/^[a-zA-Z0-9_.-]+$/.test(s) || s === "..")) throw new Error("source_archive_path");
    signal.throwIfAborted(); const out = path.join(destination, name); await fs.mkdir(path.dirname(out), { recursive:true }); await fs.writeFile(out, data);
    receipt[name] = {bytes:data.length,sha256:createHash("sha256").update(data).digest("hex")};
  }
  if (!receipt["startlux_decide/pipeline.py"]) throw new Error("source_missing");
  signal.throwIfAborted(); await fs.writeFile(path.join(destination,"receipt.json"),JSON.stringify(receipt));
}
