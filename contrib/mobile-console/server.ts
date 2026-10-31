import { createRelayServer } from "./relay.js";

const admissionSecret = process.env.VIVIC_RELAY_ADMISSION_SECRET ?? "";
const publicMode = process.env.VIVIC_RELAY_PUBLIC === "1";
const allowedOrigins = (process.env.VIVIC_RELAY_ORIGINS ?? (publicMode ? "" : "http://localhost:5174,http://127.0.0.1:5174")).split(",").filter(Boolean);
const port = Number(process.env.VIVIC_RELAY_PORT ?? 8791);
const host = process.env.VIVIC_RELAY_HOST ?? "127.0.0.1";
const trustedProxyIps = (process.env.VIVIC_RELAY_TRUSTED_PROXY_IPS ?? "").split(",").map(ip => ip.trim()).filter(Boolean);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid relay port.");
const relay = createRelayServer({ admissionSecret, allowedOrigins, publicMode, trustedProxyIps,
  allowLoopbackOrigins: process.env.VIVIC_RELAY_ALLOW_LOOPBACK_ORIGINS === "1" });
await relay.listen(port, host);
// Operational metadata only. Never print credentials, pairing codes, URLs with queries, or payloads.
console.info(`Vivic mobile relay listening on ${host}:${port}; protocol 1; ephemeral sessions; public TLS proxy mode=${publicMode}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void relay.close().then(() => process.exit(0)); });
