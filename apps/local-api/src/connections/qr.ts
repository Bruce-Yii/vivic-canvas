import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { findCli, cliArguments, type CliRunner } from "./cli.js";
import { ConnectionError, type ConnectionConfig, type ConnectionProvider } from "./types.js";

export type QrProvider = "feishu" | "wecom" | "dingtalk";
export const FeishuAppCredentialsSchema = z.object({
  appId: z.string().trim().regex(/^cli_[A-Za-z0-9_-]{4,100}$/),
  appSecret: z.string().trim().min(8).max(2048).regex(/^[^\s\0]+$/),
}).strict();
export type FeishuAppCredentials = z.infer<typeof FeishuAppCredentialsSchema>;
const PROVIDERS: QrProvider[] = ["feishu", "wecom", "dingtalk"];
export interface ManagedCliCredential { config: ConnectionConfig; run: CliRunner; dispose(): Promise<void> }
export interface QrCode { verificationUrl?: string; imageDataUrl?: string; expiresAt?: number }
export interface QrCapability { provider: QrProvider; supported: true; available: boolean; requiresAppCredentials?: boolean; reason?: string; code?: string }
export interface QrSnapshot extends QrCode {
  id: string; provider: QrProvider;
  state: "preparing" | "waiting" | "verifying" | "connected" | "cancelled" | "expired" | "failed";
  expiresAt: number; error?: string;
}
export interface QrAdapter {
  capabilities(): QrCapability[];
  authorize(provider: QrProvider, signal: AbortSignal, onCode: (code: QrCode) => void, application?: FeishuAppCredentials): Promise<ManagedCliCredential>;
}
const failure = () => new ConnectionError("qr-authorization-failed", "授权未完成，请重新扫码；企业未开放访问权限时，请联系管理员。", 502);
const isProvider = (provider: ConnectionProvider): provider is QrProvider => PROVIDERS.includes(provider as QrProvider);
const MAX_DURATION = 10 * 60_000;
let activeAuthorizations = 0;

/** Created inside one authenticated account app. No shared login or caller-supplied directory. */
export class QrAuthorizationManager {
  private flows = new Map<QrProvider, { snapshot: QrSnapshot; controller: AbortController; timer: ReturnType<typeof setTimeout>; pending: boolean }>();
  private disposed = false;
  private readonly onConnected: (credential: ManagedCliCredential, signal: AbortSignal) => Promise<void>;
  private readonly adapter: QrAdapter;
  private readonly now: () => number;
  constructor(onConnected: (credential: ManagedCliCredential, signal: AbortSignal) => Promise<void>,
    adapter: QrAdapter = new NativeQrAdapter(), now = Date.now) { this.onConnected = onConnected; this.adapter = adapter; this.now = now; }
  capabilities() { return this.adapter.capabilities(); }
  start(provider: ConnectionProvider, application?: FeishuAppCredentials): QrSnapshot {
    if (this.disposed) throw new ConnectionError("session-ended", "会话已结束，请重新登录。", 409);
    if (!isProvider(provider)) throw new ConnectionError("qr-unsupported", "此服务暂不支持扫码连接。");
    if (application) {
      if (provider !== "feishu") throw new ConnectionError("invalid-app-credentials", "此连接不接受飞书应用凭据。");
      const parsed = FeishuAppCredentialsSchema.safeParse(application);
      if (!parsed.success) throw new ConnectionError("invalid-app-credentials", "请填写有效的飞书 App ID 和 App Secret。");
      application = parsed.data;
    }
    const capability = this.capabilities().find(item => item.provider === provider);
    if (!capability?.available) throw new ConnectionError("qr-unavailable", capability?.reason ?? "此服务尚未启用扫码连接。", 503);
    if (provider === "feishu" && capability.requiresAppCredentials && !application)
      throw new ConnectionError("app-credentials-required", "请填写飞书应用的 App ID 和 App Secret。");
    if (activeAuthorizations >= 12) throw new ConnectionError("qr-busy", "扫码连接正在处理，请稍后重试。", 429);
    this.cancelProvider(provider);
    const snapshot: QrSnapshot = { id: randomUUID(), provider, state: "preparing", expiresAt: this.now() + MAX_DURATION };
    const controller = new AbortController();
    const timer = setTimeout(() => { snapshot.state = "expired"; delete snapshot.verificationUrl; delete snapshot.imageDataUrl; controller.abort(); }, MAX_DURATION);
    timer.unref();
    const flow = { snapshot, controller, timer, pending: true };
    this.flows.set(provider, flow); activeAuthorizations++;
    void (async () => {
      let credential: ManagedCliCredential | undefined;
      try {
        credential = await this.adapter.authorize(provider, controller.signal, code => {
          if (controller.signal.aborted || this.flows.get(provider) !== flow) return;
          snapshot.verificationUrl = code.verificationUrl; snapshot.imageDataUrl = code.imageDataUrl;
          if (code.expiresAt) {
            snapshot.expiresAt = Math.min(snapshot.expiresAt, code.expiresAt);
            clearTimeout(flow.timer);
            flow.timer = setTimeout(() => {
              if (!flow.pending || controller.signal.aborted) return;
              snapshot.state = "expired"; delete snapshot.verificationUrl; delete snapshot.imageDataUrl; controller.abort();
            }, Math.max(1, snapshot.expiresAt - this.now()));
            flow.timer.unref();
          }
          snapshot.state = "waiting";
        }, application);
        if (credential.config.provider !== provider || credential.config.transport !== "cli") throw failure();
        controller.signal.throwIfAborted();
        snapshot.state = "verifying"; delete snapshot.verificationUrl; delete snapshot.imageDataUrl;
        await this.onConnected(credential, controller.signal);
        credential = undefined; // ownership transferred to the verified connection
        snapshot.state = "connected";
      } catch {
        if (!controller.signal.aborted) { snapshot.state = "failed"; snapshot.error = provider === "feishu" ? "飞书授权未完成，请检查 App ID、App Secret 和应用权限后重试。" : failure().message; }
      } finally {
        if (credential) await credential.dispose().catch(() => {});
        delete snapshot.verificationUrl; delete snapshot.imageDataUrl;
        clearTimeout(flow.timer); flow.pending = false; activeAuthorizations--;
      }
    })();
    return { ...snapshot };
  }
  poll(provider: ConnectionProvider, id: string): QrSnapshot {
    const flow = isProvider(provider) ? this.flows.get(provider) : undefined;
    if (!flow || flow.snapshot.id !== id) throw new ConnectionError("qr-not-found", "扫码请求已结束，请重新发起。", 409);
    if (flow.pending && this.now() >= flow.snapshot.expiresAt) {
      flow.snapshot.state = "expired"; flow.controller.abort();
      delete flow.snapshot.verificationUrl; delete flow.snapshot.imageDataUrl;
    }
    return { ...flow.snapshot };
  }
  cancel(provider: ConnectionProvider, id: string): QrSnapshot {
    const snapshot = this.poll(provider, id);
    if (isProvider(provider) && !["connected", "failed", "expired"].includes(snapshot.state)) this.cancelProvider(provider);
    return this.poll(provider, id);
  }
  cancelProvider(provider: ConnectionProvider) {
    if (!isProvider(provider)) return;
    const flow = this.flows.get(provider);
    if (flow?.pending) {
      flow.snapshot.state = "cancelled"; delete flow.snapshot.verificationUrl; delete flow.snapshot.imageDataUrl;
      clearTimeout(flow.timer); flow.controller.abort();
    }
  }
  dispose() { this.disposed = true; for (const provider of PROVIDERS) this.cancelProvider(provider); this.flows.clear(); }
}

export function officialVerificationUrl(provider: QrProvider, raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw failure(); }
  const hosts = provider === "feishu" ? ["accounts.feishu.cn", "open.feishu.cn"] : provider === "dingtalk" ? ["login.dingtalk.com"] : [];
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.includes(url.hostname) || raw.length > 8192) throw failure();
  return raw; // retain the provider-issued link exactly
}

/** Native argv only. Output is bounded and never forwarded to the browser or logs. */
export function nativeCommand(binary: string, args: string[], root: string, env: NodeJS.ProcessEnv, signal: AbortSignal,
  onOutput?: (text: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(failure());
    const child = spawn(binary, args, { cwd: root, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    let output = "", observed = "", bytes = 0, stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { if (stopped) return; stopped = true; child.kill(); killTimer = setTimeout(() => child.kill("SIGKILL"), 1000); killTimer.unref(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const consume = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) { abort(); return; }
      const text = stdout ? decoder.write(chunk) : chunk.toString("utf8");
      if (stdout) output += text;
      observed = (observed + text).slice(-16384);
      try { onOutput?.(observed); } catch { abort(); }
    };
    child.stdout.on("data", chunk => consume(chunk, true)); child.stderr.on("data", chunk => consume(chunk, false));
    child.on("error", () => { clearTimeout(killTimer); signal.removeEventListener("abort", abort); reject(failure()); });
    child.on("close", code => { clearTimeout(killTimer); signal.removeEventListener("abort", abort); if (code !== 0 || stopped || signal.aborted) reject(failure()); else resolve(output + decoder.end()); });
  });
}

function isolatedEnvironment(root: string, provider: QrProvider, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: inherited.PATH, SystemRoot: inherited.SystemRoot, WINDIR: inherited.WINDIR,
    HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root,
    TMP: root, TEMP: root, TMPDIR: root, NO_COLOR: "1", BROWSER: "none", DO_NOT_TRACK: "1",
    LARKSUITE_CLI_CONFIG_DIR: root, LARKSUITE_CLI_DATA_DIR: root, WECOM_CLI_CONFIG_DIR: path.join(root, "wecom"), DWS_CONFIG_DIR: root,
    DWS_DISABLE_KEYCHAIN: "1",
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1", LARKSUITE_CLI_BRAND: "feishu" };
  if (provider === "feishu") { env.LARKSUITE_CLI_APP_ID = inherited.VIVIC_FEISHU_APP_ID; env.LARKSUITE_CLI_APP_SECRET = inherited.VIVIC_FEISHU_APP_SECRET; }
  if (process.platform === "linux" && existsSync("/etc/ssl/certs/ca-certificates.crt")) env.SSL_CERT_FILE = "/etc/ssl/certs/ca-certificates.crt";
  return env;
}
export async function removeOwnedRoot(root: string) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("vivic-qr-")) throw failure();
  await rm(resolved, { recursive: true, force: true });
}

export class NativeQrAdapter implements QrAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly command: typeof nativeCommand;
  private readonly locate: (provider: QrProvider) => string | undefined;
  constructor(env: NodeJS.ProcessEnv = process.env, command: typeof nativeCommand = nativeCommand,
    locate: (provider: QrProvider) => string | undefined = findCli) {
    this.env = env; this.command = command; this.locate = locate;
  }
  capabilities(): QrCapability[] {
    return PROVIDERS.map(provider => {
      const binary = this.locate(provider);
      if (!binary) return { provider, supported: true, available: false, code: "cli-not-installed", reason: "此服务尚未启用扫码连接，可继续使用手动连接。" };
      if (provider === "feishu") return { provider, supported: true, available: true,
        requiresAppCredentials: !this.env.VIVIC_FEISHU_APP_ID || !this.env.VIVIC_FEISHU_APP_SECRET };
      return { provider, supported: true, available: true };
    });
  }
  async authorize(provider: QrProvider, signal: AbortSignal, onCode: (code: QrCode) => void, application?: FeishuAppCredentials): Promise<ManagedCliCredential> {
    const binary = this.locate(provider); if (!binary) throw failure();
    let effective = this.env;
    if (application) {
      if (provider !== "feishu") throw failure();
      const parsed = FeishuAppCredentialsSchema.safeParse(application); if (!parsed.success) throw failure();
      effective = { ...this.env, VIVIC_FEISHU_APP_ID: parsed.data.appId, VIVIC_FEISHU_APP_SECRET: parsed.data.appSecret };
    }
    if (provider === "feishu" && (!effective.VIVIC_FEISHU_APP_ID || !effective.VIVIC_FEISHU_APP_SECRET)) throw failure();
    const root = await mkdtemp(path.join(tmpdir(), "vivic-qr-")), env = isolatedEnvironment(root, provider, effective);
    let transferred = false;
    try {
      if (provider === "feishu") {
        const raw = JSON.parse(await this.command(binary, ["auth", "login", "--scope", "drive:drive:readonly docx:document:readonly wiki:wiki:readonly search:docs:read", "--no-wait", "--json"], root, env, signal));
        const data = raw.data ?? raw;
        if (typeof data.device_code !== "string" || !data.device_code || data.device_code.length > 8192 || typeof data.verification_url !== "string") throw failure();
        const seconds = Number(data.expires_in ?? 240);
        if (!Number.isFinite(seconds) || seconds <= 0) throw failure();
        onCode({ verificationUrl: officialVerificationUrl(provider, data.verification_url), expiresAt: Date.now() + Math.min(MAX_DURATION, seconds * 1000) });
        await this.command(binary, ["auth", "login", "--device-code", data.device_code, "--json"], root, env, signal);
      } else if (provider === "wecom") {
        const qrFile = path.join(root, "qrcode.png");
        let emitted = false, reading = false;
        const readQr = async () => {
          if (emitted || reading || signal.aborted) return; reading = true;
          try {
            const info = await lstat(qrFile); if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) return;
            const png = await readFile(qrFile);
            if (png.length < 8 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return;
            emitted = true; onCode({ imageDataUrl: "data:image/png;base64," + png.toString("base64"), expiresAt: Date.now() + 5 * 60_000 });
          } catch { /* CLI creates the image asynchronously. */ } finally { reading = false; }
        };
        const timer = setInterval(() => void readQr(), 150); timer.unref();
        try { await this.command(binary, ["auth", "init", "--noninteractive", "--no-browser", "--output-qrcode", "qrcode.png"], root, env, signal); }
        finally { clearInterval(timer); }
      } else {
        let emitted = false;
        await this.command(binary, ["auth", "login", "--device", "--no-browser"], root, env, signal, text => {
          if (emitted) return;
          const match = text.match(/https:\/\/login\.dingtalk\.com\/[^\s\x1b<>"']+(?=[\s\x1b<>"'])/);
          if (match) { emitted = true; onCode({ verificationUrl: officialVerificationUrl(provider, match[0]) }); }
        });
        if (!emitted) throw failure();
      }
      signal.throwIfAborted();
      const config: ConnectionConfig = { provider, transport: "cli", ...(provider === "feishu" ? { appId: effective.VIVIC_FEISHU_APP_ID } : {}) };
      const running = new Set<Promise<unknown>>(); let disposed = false, cleanup: Promise<void> | undefined;
      const execute: CliRunner = async (_config, name, args, commandSignal) => {
        if (disposed) throw failure();
        const bounded = AbortSignal.any([commandSignal, AbortSignal.timeout(30000)]);
        const text = await this.command(binary, cliArguments(provider, name, args), root, env, bounded);
        let result: any; try { result = JSON.parse(text); } catch {
          if (provider === "dingtalk" && name === "fetch-doc") return { content: [{ type: "text", text }] };
          throw failure();
        }
        if (!result || result.ok === false || result.success === false || result.error || typeof result.code === "number" && result.code !== 0 || typeof result.errcode === "number" && result.errcode !== 0) throw failure();
        if (provider === "dingtalk" && name === "test") { const status = result.data ?? result; if (!status.authenticated || !status.token_valid || status.reason) throw failure(); }
        return result;
      };
      const lease: ManagedCliCredential = { config,
        dispose: () => cleanup ??= (async () => { disposed = true; await Promise.allSettled([...running]); await removeOwnedRoot(root); })(),
        run: (configuration, name, args, commandSignal) => {
          const task = execute(configuration, name, args, commandSignal); running.add(task);
          void task.finally(() => running.delete(task)).catch(() => {}); return task;
        } };
      transferred = true; return lease;
    } finally { if (!transferred) await removeOwnedRoot(root).catch(() => {}); }
  }
}
