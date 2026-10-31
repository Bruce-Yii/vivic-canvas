import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { installOpenAIEgress, redactProxy } from "./openaiProxy.js";
import { filePreferences } from "./preferences.js";
import { writeDiagnostic } from "./diagnostics.js";
import { createBrowserFetch } from "./browserFetch.js";

// Before anything fetches: OpenAI must leave through the user's proxy.
const egress = installOpenAIEgress();
const egressProxy = egress.current();
console.log(egressProxy
  ? `[vivic-local-api] OpenAI egress via ${redactProxy(egressProxy.url)} (${egressProxy.source}); other hosts direct`
  : "[vivic-local-api] OpenAI egress direct (no proxy configured)");

const config = loadConfig();
// Automated browser runs set VIVIC_PREFERENCES=off so they never restore or
// overwrite the user's real connection choice.
const preferences = process.env.VIVIC_PREFERENCES === "off" ? undefined
  : filePreferences(path.join(homedir(), ".vivic", "preferences.json"));
const app = createApp({ config, preferences, onDiagnostic: writeDiagnostic });

/**
 * Production story (documented in README): after `pnpm --filter @vivic/web
 * build`, this same loopback process also serves apps/web/dist, so a single
 * `pnpm dev:api` can host the whole local product. Auth on /api is unchanged.
 */
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
