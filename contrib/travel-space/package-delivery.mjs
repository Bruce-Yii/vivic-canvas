import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const requireWeb = createRequire(path.resolve(here, "../../apps/web/package.json"));
const { zipSync } = requireWeb("fflate");
const entries = {};
async function addDir(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await addDir(file, name);
    else if (entry.isFile()) entries[name] = new Uint8Array(await readFile(file));
  }
}
await addDir(path.join(here, "dist"), "dist");
const markup = await readFile(path.join(here, "dist", "index.html"), "utf8");
const assetUrl = markup.match(/src="([^"]*\/assets\/[^\"]+)"/)?.[1] ?? "/assets/";
const basePath = assetUrl.slice(0, assetUrl.indexOf("/assets/") + 1);
entries["server.mjs"] = new Uint8Array(await readFile(path.join(here, "server.mjs")));
entries["START-HERE.md"] = new TextEncoder().encode(`# Travel Vivic Space · DEMO\n\nThis build targets ${basePath}. Upload the contents of dist/ to that path on an HTTPS site.\n\nThe optional Node server (Node 22+, node server.mjs) directly serves root-path builds at http://127.0.0.1:5196/. A subpath build needs a reverse proxy that strips the prefix, or a fresh root-path build. For a reverse proxy set TRAVEL_PUBLIC_ORIGIN to the exact public HTTPS origin. Keep TRAVEL_HOST=127.0.0.1. Server uses only Node built-ins.\n\nThis package is an offline planning demonstration. No live model/MCP service, prices, inventory, booking, accounts or paid calls. API keys are not read. Visitors keep their own plans in browser storage; no personal canvas access. Share the application URL, not a local plan.\n\nSource/build/integration instructions are in contrib/travel-space/README.md in the Vivic source repository. Third-party licenses are preserved in dist/THIRD-PARTY-NOTICES.txt.\n`);
const zip = zipSync(entries, { level: 6 });
const output = path.join(here, "artifacts", "travel-vivic-space-demo.zip");
await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, zip);
const sha = createHash("sha256").update(zip).digest("hex");
await writeFile(output + ".sha256", `${sha}  travel-vivic-space-demo.zip\n`);
process.stdout.write(`${output}\nSHA256 ${sha}\n`);
