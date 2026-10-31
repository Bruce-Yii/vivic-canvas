import { execFileSync } from "node:child_process";
import { Agent, Dispatcher, ProxyAgent, interceptors, setGlobalDispatcher } from "undici";

/**
 * OpenAI egress. Node's fetch ignores the system proxy, so on a machine whose
 * direct exit is in an unsupported region every OpenAI call (OAuth token
 * exchange, refresh, model catalog, inference) fails with HTTP 403
 * `unsupported_country_region_territory` while the browser — which does use
 * the proxy — happily completes the authorization page.
 *
 * Only OpenAI/ChatGPT hosts are routed through a proxy; StepFun and every
 * other origin keep their direct connection.
 */

const OPENAI_DOMAINS = ["openai.com", "chatgpt.com"];
const SYSTEM_PROXY_TTL_MS = 30_000;
/**
 * Measured on the user's proxy (2026-10-17): TLS through a fresh tunnel takes
 * 3.5–9.5 s, so undici's default 10 s handshake limit failed about half of the
 * cold requests, and its 4 s idle limit threw every tunnel away between turns.
 * A warm tunnel answers in ~0.4 s, so keep it for minutes; one the proxy or
 * OpenAI closes while idle is simply dropped from the pool and rebuilt.
 */
const TUNNEL_OPTIONS = {
  requestTls: { timeout: 30_000 },
  keepAliveTimeout: 5 * 60_000,
  keepAliveMaxTimeout: 10 * 60_000,
};
/**
 * Desktop proxy apps often stall the first tunnel while picking a node. Only
 * connect-phase failures are retried: the request never reached OpenAI, so
 * even a single-use OAuth authorization code is safe to resend.
 */
const CONNECT_RETRY = {
  maxRetries: 2, minTimeout: 300, timeoutFactor: 2, statusCodes: [],
  methods: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] as Dispatcher.HttpMethod[],
  errorCodes: ["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED"],
};

export const isOpenAIHost = (host: string): boolean => {
  const name = host.toLowerCase().replace(/\.$/, "");
  return OPENAI_DOMAINS.some(domain => name === domain || name.endsWith(`.${domain}`));
};

const withScheme = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Windows `ProxyServer` is either `host:port` (all protocols) or a list such
 * as `http=h:p;https=h:p;socks=h:p`. SOCKS-only entries are not usable here.
 */
export const parseWindowsProxyServer = (value: string): string | undefined => {
  const entries = value.split(";").map(part => part.trim()).filter(Boolean);
  if (entries.length === 1 && !entries[0]!.includes("=")) return withScheme(entries[0]!);
  const byScheme = new Map(entries.map(entry => {
    const [scheme, address = ""] = entry.split("=", 2);
    return [scheme!.trim().toLowerCase(), address.trim()] as const;
  }));
  const address = byScheme.get("https") || byScheme.get("http");
  return address ? withScheme(address) : undefined;
};

const readWindowsSystemProxy = (): string | undefined => {
  if (process.platform !== "win32") return undefined;
  try {
    const output = execFileSync("reg", [
      "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    ], { encoding: "utf8", timeout: 3000, windowsHide: true });
    const value = (name: string) => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, "mi").exec(output)?.[1]?.trim();
    if (Number(value("ProxyEnable")) !== 1) return undefined;
    const server = value("ProxyServer");
    return server ? parseWindowsProxyServer(server) : undefined;
  } catch {
    return undefined;
  }
};

/** `scutil --proxy` prints the active macOS network service's proxy dictionary. */
export const parseMacProxy = (output: string): string | undefined => {
  const value = (name: string) => new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, "m").exec(output)?.[1];
  for (const scheme of ["HTTPS", "HTTP"]) {
    const host = value(`${scheme}Proxy`);
    const port = value(`${scheme}Port`);
    if (value(`${scheme}Enable`) === "1" && host) return withScheme(port ? `${host}:${port}` : host);
  }
  return undefined;
};

const readMacSystemProxy = (): string | undefined => {
  try {
    return parseMacProxy(execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 3000 }));
  } catch {
    return undefined;
  }
};

/** Linux desktops publish their proxy through the environment, covered by `env`. */
export const readSystemProxy = (): string | undefined =>
  process.platform === "win32" ? readWindowsSystemProxy()
    : process.platform === "darwin" ? readMacSystemProxy() : undefined;

export type ProxySource = "VIVIC_OPENAI_PROXY" | "VIVIC_SEARCH_PROXY" | "env" | "system";
export interface ResolvedProxy { url: string; source: ProxySource }

/** The proxy the user's browser would use: environment first, then the OS. */
export const resolveAmbientProxy = (
  env: NodeJS.ProcessEnv,
  readSystem: () => string | undefined = readSystemProxy,
): ResolvedProxy | undefined => {
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const url = env[name] ? withScheme(env[name]!) : undefined;
    if (url) return { url, source: "env" };
  }
  const system = readSystem();
  return system ? { url: system, source: "system" } : undefined;
};

/** `direct|off|none` opts out, `auto`/unset follows env > system, anything else is a proxy URL. */
const resolveWithOverride = (
  override: string | undefined, source: ProxySource, env: NodeJS.ProcessEnv, readSystem: () => string | undefined,
): ResolvedProxy | undefined => {
  const explicit = override?.trim();
  if (explicit && /^(direct|off|none)$/i.test(explicit)) return undefined;
  if (explicit && !/^auto$/i.test(explicit)) {
    const url = withScheme(explicit);
    return url ? { url, source } : undefined;
  }
  return resolveAmbientProxy(env, readSystem);
};

/** `VIVIC_OPENAI_PROXY=direct` opts out; otherwise explicit > env > system. */
export const resolveOpenAIProxy = (
  env: NodeJS.ProcessEnv,
  readSystem: () => string | undefined = readSystemProxy,
): ResolvedProxy | undefined => resolveWithOverride(env.VIVIC_OPENAI_PROXY, "VIVIC_OPENAI_PROXY", env, readSystem);

/**
 * Egress for the fixed keyless search endpoint only. Never for user/model
 * supplied page URLs: a proxy resolves names itself and would bypass the
 * pinned public-address check that guards /api/fetch.
 */
export const resolveSearchProxy = (
  setting: string | undefined,
  env: NodeJS.ProcessEnv,
  readSystem: () => string | undefined = readSystemProxy,
): ResolvedProxy | undefined => resolveWithOverride(setting, "VIVIC_SEARCH_PROXY", env, readSystem);

/** Re-read periodically so turning a proxy app on/off needs no restart. */
export const cachedProxy = (resolve: () => ResolvedProxy | undefined, ttlMs = SYSTEM_PROXY_TTL_MS) => {
  let cached: { at: number; value: ResolvedProxy | undefined } | undefined;
  return (): ResolvedProxy | undefined => {
    const now = Date.now();
    if (!cached || now - cached.at >= ttlMs) cached = { at: now, value: resolve() };
    return cached.value;
  };
};

/** A tunnel pool with the timeouts and connect-phase retry described above. */
export const tunnelAgent = (url: string): Dispatcher =>
  new ProxyAgent({ uri: url, ...TUNNEL_OPTIONS }).compose(interceptors.retry(CONNECT_RETRY));

const proxyAgents = new Map<string, Dispatcher>();
/** One tunnel pool per proxy URL. */
export const proxyDispatcher = (url: string): Dispatcher => {
  let agent = proxyAgents.get(url);
  if (!agent) { agent = tunnelAgent(url); proxyAgents.set(url, agent); }
  return agent;
};

/** Never log proxy credentials. */
export const redactProxy = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<invalid>";
  }
};

export class OpenAIEgressDispatcher extends Dispatcher {
  readonly #direct: Dispatcher;
  readonly #current: () => ResolvedProxy | undefined;
  readonly #agents = new Map<string, Dispatcher>();

  constructor(options: { resolve: () => ResolvedProxy | undefined; direct?: Dispatcher; ttlMs?: number }) {
    super();
    this.#direct = options.direct ?? new Agent();
    this.#current = cachedProxy(options.resolve, options.ttlMs);
  }

  current(): ResolvedProxy | undefined {
    return this.#current();
  }

  route(origin: string | URL | undefined): Dispatcher {
    let host = "";
    try { host = origin ? new URL(origin).hostname : ""; } catch { /* direct */ }
    const proxy = host && isOpenAIHost(host) ? this.current() : undefined;
    if (!proxy) return this.#direct;
    let agent = this.#agents.get(proxy.url);
    if (!agent) { agent = tunnelAgent(proxy.url); this.#agents.set(proxy.url, agent); }
    return agent;
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return this.route(options.origin).dispatch(options, handler);
  }

  override async close(): Promise<void> {
    await Promise.all([this.#direct.close(), ...[...this.#agents.values()].map(agent => agent.close())]);
  }

  override async destroy(): Promise<void> {
    await Promise.all([this.#direct.destroy(), ...[...this.#agents.values()].map(agent => agent.destroy())]);
  }
}

/** Installs the router as the process-wide fetch dispatcher; returns it. */
export const installOpenAIEgress = (env: NodeJS.ProcessEnv = process.env): OpenAIEgressDispatcher => {
  const dispatcher = new OpenAIEgressDispatcher({ resolve: () => resolveOpenAIProxy(env) });
  setGlobalDispatcher(dispatcher);
  return dispatcher;
};
