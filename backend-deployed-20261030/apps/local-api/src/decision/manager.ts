import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { DecisionProvider, DecisionProviderState } from "./provider.js";
import { acceptedDecision } from "./intent.js";
import { createBudget } from "../intent/budget.js";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const replySchema = z.object({ id: z.number().int(), probabilities: z.array(z.number().finite().min(0).max(1)).length(7), ms: z.number().finite().min(0).max(30000) });
export interface DecisionStatus { phase: "absent" | "downloading" | "installing" | "cached" | "loading" | "ready" | "stopping" | "error"; enabled: boolean; model: string; bytes: number; gpuBytes: number; lastMs: number | null; error: string | null; mode?: "provider" | "managed"; lastState?: DecisionProviderState; downloadedBytes?: number; totalBytes?: number; scoreSource?: string }
export class DecisionManager {
  private worker: ChildProcess | undefined;
  private preparing: ChildProcess | undefined;
  private serial = 0;
  private pending: { id: number; finish: (value: number[] | null) => void } | undefined;
  private state: DecisionStatus = { phase: "absent", enabled: false, model: "Kev-0.8B", bytes: 1825383500, gpuBytes: 0, lastMs: null, error: null };
  private cache: string;
  private readonly provider?: DecisionProvider;
  private providerRevision = 0;
  private providerRequests = new Set<AbortController>();
  private readonly providerTimeoutMs: number;
  private providerRetryAt = 0;
  private readonly failureCooldownMs: number;
  constructor(cache = path.join(root, ".cache/decision-model/kev-0.8b"), provider?: DecisionProvider,
    options: { enabled?: boolean; timeoutMs?: number; failureCooldownMs?: number; modelLabel?: string } = {}) {
    this.cache = cache; this.provider = provider;
    this.providerTimeoutMs = options.timeoutMs ?? 20_000;
    this.failureCooldownMs = options.failureCooldownMs ?? 30_000;
    if (provider) this.state = { ...this.state, mode: "provider", enabled: options.enabled !== false,
      phase: options.enabled === false ? "cached" : "ready", model: options.modelLabel ?? "DEC-01 决策服务", bytes: 0 };
    if (provider?.controls) this.state = { ...this.state, ...provider.controls.status() };
  }
  private cached() { return fs.existsSync(path.join(this.cache, "venv/bin/python")) && fs.existsSync(path.join(this.cache, "model/base/model.safetensors-00001-of-00001.safetensors")); }
  status(): DecisionStatus {
    if (this.provider?.controls) {
      const runtime = this.provider.controls.status();
      return { ...this.state, ...runtime, enabled: this.state.enabled && runtime.enabled,
        phase: runtime.phase === "ready" && this.state.phase === "error" ? "error" : runtime.phase,
        error: this.state.error ?? runtime.error };
    }
    if (!this.provider && ["absent", "cached"].includes(this.state.phase)) this.state.phase = this.cached() ? "cached" : "absent";
    return { ...this.state };
  }
  private env() { return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8" }; }
  private terminate(child: ChildProcess | undefined) { if (child?.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already closed. */ } } }
  prepare() {
    if (this.provider?.controls) { this.state.error = null; this.provider.controls.prepare(); return this.status(); }
    if (this.provider) return this.status();
    if (this.preparing || this.worker) return this.status();
    this.state = { ...this.state, phase: "downloading", error: null };
    const child = spawn("python3", [path.join(root, "scripts/decision-model/prepare.py"), "--cache-dir", this.cache], {
      env: this.env(), detached: true, stdio: ["ignore", "pipe", "ignore"] });
    this.preparing = child; let buffer = "";
    const timer = setTimeout(() => { this.terminate(child); }, 15 * 60000);
    child.stdout?.on("data", chunk => {
      buffer += String(chunk); if (buffer.length > 16384) { this.terminate(child); return; }
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) { try { const data = JSON.parse(line); if (["downloading", "installing", "cached"].includes(data.phase)) this.state.phase = data.phase; } catch { /* No untrusted child text is surfaced. */ } }
    });
    child.on("error", () => { this.state.phase = "error"; this.state.error = "准备失败，请确认网络、Python 3 和 uv 可用后重试。"; });
    child.on("close", code => { clearTimeout(timer); if (this.preparing !== child) return; this.preparing = undefined;
      this.state.phase = code === 0 && this.cached() ? "cached" : "error";
      this.state.error = this.state.phase === "error" ? "模型准备未完成，请重试。" : null; });
    return this.status();
  }
  enable() {
    if (this.provider) {
      this.providerRetryAt = 0;
      this.state = { ...this.state, enabled: true, phase: "ready", error: null };
      this.provider.controls?.enable();
      return this.status();
    }
    if (this.worker || this.preparing) return this.status();
    if (!this.cached()) { this.state.error = "请先准备固定的 Kev 模型。"; return this.status(); }
    this.state = { ...this.state, phase: "loading", enabled: true, error: null };
    const child = spawn(path.join(this.cache, "venv/bin/python"), [path.join(root, "scripts/decision-model/worker.py"), "--cache-dir", this.cache], {
      env: this.env(), detached: true, stdio: ["pipe", "pipe", "ignore"] });
    this.worker = child; let buffer = "";
    const timeout = setTimeout(() => { if (this.state.phase === "loading") { this.stop(); this.state.phase = "error"; this.state.error = "本地模型加载超时。"; } }, 60000);
    child.stdout?.on("data", chunk => {
      buffer += String(chunk); if (buffer.length > 16384) { this.stop(); this.state.phase = "error"; return; }
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) {
        try {
          const raw = JSON.parse(line);
          if (raw.ready === true && Number.isFinite(raw.gpuBytes)) { clearTimeout(timeout); this.state.phase = "ready"; this.state.gpuBytes = raw.gpuBytes; continue; }
          const parsed = replySchema.safeParse(raw);
          const pending = this.pending;
          if (!pending || pending.id !== raw.id) continue;
          if (parsed.success && Math.abs(parsed.data.probabilities.reduce((a, b) => a + b, 0) - 1) < .01) {
            this.state.lastMs = parsed.data.ms; pending.finish(parsed.data.probabilities);
          } else pending.finish(null);
        } catch { this.pending?.finish(null); }
      }
    });
    child.on("error", () => { this.stop(); this.state.phase = "error"; this.state.error = "本地模型进程不可用。"; });
    child.on("close", () => { clearTimeout(timeout); if (this.worker !== child) return; this.worker = undefined; this.pending?.finish(null);
      this.state = { ...this.state, enabled: false, phase: "error", gpuBytes: 0, error: "本地模型已停止，可重新启用；其他指令仍可使用。" }; });
    return this.status();
  }
  score(text: string, signal?: AbortSignal): Promise<number[] | null> {
    if (this.provider) return this.scoreWithProvider(text, signal);
    return this.scoreLocal(text, signal);
  }
  private async scoreWithProvider(text: string, signal?: AbortSignal): Promise<number[] | null> {
    if (this.provider?.controls && this.provider.controls.status().phase !== "ready") return null;
    if (!this.state.enabled || signal?.aborted || !text.trim() || text.length > 500 || this.providerRequests.size || Date.now() < this.providerRetryAt) return null;
    const revision = this.providerRevision, controller = new AbortController(), started = performance.now();
    const budget = createBudget(this.providerTimeoutMs, [signal, controller.signal]);
    this.providerRequests.add(controller);
    try {
      const remote = await budget.run(() => this.provider!.decide(text, budget.signal));
      if (revision !== this.providerRevision || !this.state.enabled) return null;
      const scores = remote.state === "accepted" && remote.probabilities && acceptedDecision(text, remote.probabilities)
        ? remote.probabilities : null;
      this.state.lastState = remote.state === "accepted" && !scores ? "deferred" : remote.state;
      this.state.lastMs = performance.now() - started;
      this.state.phase = remote.state === "error" || remote.state === "timeout" ? "error" : "ready";
      this.providerRetryAt = this.state.phase === "error" ? Date.now() + this.failureCooldownMs : 0;
      this.state.error = this.state.phase === "error" ? "决策服务暂不可用，本次使用原有指令流程。" : null;
      return scores;
    } catch {
      if (revision === this.providerRevision && this.state.enabled) {
        this.state.lastState = signal?.aborted ? "cancelled" : budget.signal.aborted ? "timeout" : "error";
        this.state.lastMs = performance.now() - started;
        this.state.phase = signal?.aborted ? "ready" : "error";
        this.providerRetryAt = signal?.aborted ? 0 : Date.now() + this.failureCooldownMs;
        this.state.error = signal?.aborted ? null : "决策服务暂不可用，本次使用原有指令流程。";
      }
      return null;
    } finally { budget.dispose(); this.providerRequests.delete(controller); }
  }
  private scoreLocal(text: string, signal?: AbortSignal): Promise<number[] | null> {
    if (this.state.phase !== "ready" || !this.worker || this.pending || signal?.aborted) return Promise.resolve(null);
    const id = ++this.serial;
    return new Promise(resolve => {
      const abort = () => finish(null);
      const timer = setTimeout(() => { this.stop(); this.state.phase = "error"; this.state.error = "本地决策超时，已卸载；本次回到原有指令流程。"; }, 1000);
      const finish = (value: number[] | null) => { if (this.pending?.id !== id) return; this.pending = undefined; clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(value); };
      this.pending = { id, finish }; signal?.addEventListener("abort", abort, { once: true });
      this.worker!.stdin?.write(JSON.stringify({ id, text }) + "\n", error => { if (error) finish(null); });
    });
  }
  stop() {
    this.providerRetryAt = 0;
    this.providerRevision++;
    for (const request of this.providerRequests) request.abort();
    if (this.provider) {
      this.provider.controls?.stop();
      this.state = { ...this.state, enabled: false, phase: "cached", error: null, lastState: "disabled" };
      return this.status();
    }
    const worker = this.worker, preparing = this.preparing;
    this.worker = undefined; this.preparing = undefined; this.pending?.finish(null);
    this.terminate(worker); this.terminate(preparing);
    this.state = { ...this.state, enabled: false, phase: this.cached() ? "cached" : "absent", gpuBytes: 0 };
    return this.status();
  }
  clear() { this.stop(); if (this.provider) { this.provider.controls?.clear(); return this.status(); } fs.rmSync(path.join(this.cache, "model"), { recursive: true, force: true }); this.state.phase = "absent"; return this.status(); }
}
