import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp, type AppDeps } from "./app.js";
import { loadConfig } from "./config.js";
import { createIntentRouter } from "./decision/router.js";
import { installOpenAIEgress, redactProxy } from "./openaiProxy.js";
import { filePreferences } from "./preferences.js";
import { writeDiagnostic } from "./diagnostics.js";
import { createBrowserFetch } from "./browserFetch.js";

export interface LocalAppOptions extends Partial<Omit<AppDeps, "config">> {
  config?: AppDeps["config"];
}

/**
 * The local product composition root. It injects the same `createIntentRouter`
 * used by `hosted/service.ts`, so a local turn gets the on-mode route hint and
 * the host deletion guard instead of silently degrading to "execute the
 * planner's delete envelope". The router still follows the existing
 * `VIVIC_DECISION_MODE`/`VIVIC_DECISION_URL`/`_KEY` configuration; the safety
 * gate itself lives in `createApp` and no longer depends on a router.
 */
export const createLocalApp = (options: LocalAppOptions = {}) => {
  const config = options.config ?? loadConfig();
  // Automated browser runs set VIVIC_PREFERENCES=off so they never restore or
  // overwrite the user's real connection choice.
  const preferences = Object.hasOwn(options, "preferences") ? options.preferences
    : process.env.VIVIC_PREFERENCES === "off" ? undefined
      : filePreferences(path.join(homedir(), ".vivic", "preferences.json"));
  return createApp({
    ...options,
    config,
    preferences,
    onDiagnostic: options.onDiagnostic ?? writeDiagnostic,
    router: options.router ?? createIntentRouter(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
};

/**
 * Production story (documented in README): after `pnpm --filter @vivic/web
 * build`, this same loopback process also serves apps/web/dist, so a single
 * `pnpm dev:api` can host the whole local product. Auth on /api is unchanged.
 */
function startLocalApi() {
  // Before anything fetches: OpenAI must leave through the user's proxy.
  const egress = installOpenAIEgress();
  const egressProxy = egress.current();
  console.log(egressProxy
    ? `[vivic-local-api] OpenAI egress via ${redactProxy(egressProxy.url)} (${egressProxy.source}); other hosts direct`
    : "[vivic-local-api] OpenAI egress direct (no proxy configured)");

  const config = loadConfig();
  const app = createLocalApp({ config, providerDataDir: path.join(homedir(), ".vivic") });

  const dist = path.resolve(import.meta.dirname, "../../web/dist");
  if (fs.existsSync(dist)) {
    // Only real files under dist are served; /api and /healthz fall through to
    // the routes defined above.
    app.use("/*", serveStatic({ root: dist }));
    for (const route of ["/", "/control", "/display", "/mobile", "/launcher"]) app.get(route, serveStatic({ path: path.join(dist, "index.html") }));
  }

  const server = serve(
    { fetch: createBrowserFetch(app.fetch, config.port, config.token), hostname: config.host, port: config.port },
    (info) => {
      console.log(`[vivic-local-api] listening on http://${info.address}:${info.port} (loopback only)`);
      if (config.tokenGenerated) {
        console.log(`[vivic-local-api] session token written to ${config.tokenPath}`);
      }
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    app.dispose(); server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
  process.once("exit", () => { app.dispose(); });
}

// Importing this module (tests, tooling) must not open a port or touch egress.
const entry = process.argv[1];
const selfPath = fileURLToPath(import.meta.url);
const samePath = (a: string, b: string) => process.platform === "win32"
  ? a.toLowerCase() === b.toLowerCase() : a === b;
if (entry !== undefined && samePath(path.resolve(entry), selfPath)) startLocalApi();
