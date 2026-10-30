import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import { parseFrame } from "@vivic/mobile-console-prototype/protocol";
import { validateRelayUrl } from "@vivic/mobile-console-prototype/transport";

const Settings = z.object({ relayUrl: z.string(), mobileUrl: z.url(), admissionSecret: z.string().min(32).max(256), origin: z.url() }).strict();
type Grant = { deviceId: string; token: string; relayUrl: string; mobileUrl: string; expiresAt: number };
export class MobileSessionBroker {
  private busy = false;
  private nextAt = 0;
  private sockets = new Set<WebSocket>();
  // Volatile only. The public tab slot is a lookup key, never authorization.
  // API authentication and exact-origin checks protect every lookup.
  private grants = new Map<string, Grant>();
  readonly configFile: string;
  constructor(configFile: string) { this.configFile = configFile; }
  private async settings() {
    const stat = await fs.stat(this.configFile); if (stat.size > 4096) throw new Error("invalid_settings");
    const result = Settings.parse(JSON.parse(await fs.readFile(this.configFile, "utf8")));
    validateRelayUrl(result.relayUrl);
    const mobile = new URL(result.mobileUrl);
    if (mobile.username || mobile.password || mobile.search || mobile.hash
      || mobile.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(mobile.hostname)) throw new Error("invalid_mobile_origin");
    return result;
  }
  async status() {
    try { const settings = await this.settings(); return { configured: true, mobileUrl: settings.mobileUrl }; }
    catch { return { configured: false, mobileUrl: null }; }
  }
  resume(slot: string) {
    const grant = this.grants.get(slot);
    if (grant && grant.expiresAt > Date.now()) return { ...grant };
    this.grants.delete(slot); return null;
  }
  async end(slot: string) {
    const grant = this.grants.get(slot); this.grants.delete(slot);
    if (!grant) return;
    const settings = await this.settings();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(grant.relayUrl, { origin: settings.origin, maxPayload: 32768, handshakeTimeout: 5000, perMessageDeflate: false });
      this.sockets.add(socket);
      const finish = (ok: boolean) => { clearTimeout(timer); this.sockets.delete(socket); socket.close(); ok ? resolve() : reject(new Error("relay_unavailable")); };
      const timer = setTimeout(() => { socket.terminate(); finish(false); }, 6000);
      socket.once("open", () => socket.send(JSON.stringify({ v: 1, type: "hello", role: "computer", deviceId: grant.deviceId, deviceName: "Vivic 电脑", token: grant.token })));
      socket.once("message", data => {
        const frame = parseFrame(data.toString());
        if (frame?.type === "error" && /invalid-session|expired|revoked/.test(frame.code)) { finish(true); return; }
        if (frame?.type !== "welcome" || frame.deviceId !== grant.deviceId) { finish(false); return; }
        socket.send(JSON.stringify({ v: 1, type: "revoke", sessionId: frame.sessionId, epoch: frame.epoch, deviceId: grant.deviceId }), error => finish(!error));
      });
      socket.once("error", () => finish(false));
    });
  }
  async create(slot?: string) {
    if (this.busy || Date.now() < this.nextAt) throw new Error("session_busy");
    this.busy = true; this.nextAt = Date.now() + 3000;
    try {
      if (slot) {
        await this.end(slot);
        for (const [key, grant] of this.grants) if (grant.expiresAt <= Date.now()) this.grants.delete(key);
        if (this.grants.size >= 64) throw new Error("session_capacity");
      }
      const settings = await this.settings(), deviceId = randomUUID();
      const grant = await new Promise<Grant>((resolve, reject) => {
        const socket = new WebSocket(settings.relayUrl, { origin: settings.origin, maxPayload: 32768, handshakeTimeout: 10_000, perMessageDeflate: false });
        this.sockets.add(socket);
        const finish = (result?: { token: string; expiresAt: number }) => {
          clearTimeout(timer); this.sockets.delete(socket); socket.close();
          if (result) resolve({ deviceId, token: result.token, relayUrl: settings.relayUrl, mobileUrl: settings.mobileUrl, expiresAt: result.expiresAt });
          else reject(new Error("relay_unavailable"));
        };
        const timer = setTimeout(() => { socket.terminate(); finish(); }, 12_000);
        socket.once("open", () => socket.send(JSON.stringify({ v: 1, type: "hello", role: "computer", deviceId,
          deviceName: "Vivic 电脑", accessKey: settings.admissionSecret })));
        socket.once("message", data => { const frame = parseFrame(data.toString()); finish(frame?.type === "welcome" && frame.deviceId === deviceId ? frame : undefined); });
        socket.once("error", () => finish());
        socket.once("close", () => { clearTimeout(timer); this.sockets.delete(socket); reject(new Error("relay_closed")); });
      });
      if (slot) this.grants.set(slot, grant);
      return { ...grant };
    } finally { this.busy = false; }
  }
  dispose() { this.sockets.forEach(socket => socket.terminate()); this.sockets.clear(); this.grants.clear(); }
}
