// Folds the standalone landing build (vite.landing.config.ts) into one HTML file.
// Usage: LANDING_SINGLE=1 vite build --config vite.landing.config.ts && node scripts/inline-landing.mjs [output file]
// (default output dist-landing-single/vivic-landing.html)
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const buildDir = path.join(root, "dist-landing-single");
const htmlFile = path.join(buildDir, "landing", "index.html");
const output = path.resolve(process.argv[2] ?? path.join(buildDir, "vivic-landing.html"));

let html = fs.readFileSync(htmlFile, "utf8");
const read = ref => fs.readFileSync(path.resolve(path.dirname(htmlFile), ref.split("?")[0]), "utf8");
const used = new Set();

html = html.replace(/<script type="module"[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (_, src) => {
  used.add(src);
  // An inline script ends at the first "</script", wherever it appears.
  return `<script type="module">${read(src).replace(/<\/script/gi, "<\\/script")}</script>`;
});
html = html.replace(/<link rel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g, (_, href) => {
  used.add(href);
  return `<style>${read(href).replace(/<\/style/gi, "<\\/style")}</style>`;
});
html = html.replace(/<link rel="icon"[^>]*\bhref="([^"]+)"[^>]*>/g, () => {
  const svg = fs.readFileSync(path.join(root, "public", "favicon.svg"));
  return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${svg.toString("base64")}">`;
});

const leftovers = [...html.matchAll(/(?:src|href)="(\.{0,2}\/assets\/[^"]+)"/g)].map(match => match[1]);
if (leftovers.length) throw new Error(`Unresolved asset references: ${leftovers.join(", ")}`);

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html);
console.log(`${path.relative(process.cwd(), output)}  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KiB  (inlined ${used.size} files)`);
