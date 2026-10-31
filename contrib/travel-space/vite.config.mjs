import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "../../apps/web");
const requireWeb = createRequire(path.join(web, "package.json"));
const { default: react } = await import(pathToFileURL(requireWeb.resolve("@vitejs/plugin-react")).href);
const { default: tailwind } = await import(pathToFileURL(requireWeb.resolve("@tailwindcss/vite")).href);
const notices = () => {
  const names = ["react", "react-dom", "lucide-react", "zod", "cn", "tailwindcss", "shadcn", "tw-animate-css", "tw-shimmer", "@fontsource-variable/geist"];
  const directories = names.map(name => path.join(web, "node_modules", name));
  directories.push(path.dirname(createRequire(requireWeb.resolve("react-dom")).resolve("scheduler/package.json")));
  return directories.map(directory => {
    const meta = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    const file = ["LICENSE", "LICENSE.md", "LICENSE.txt"].find(name => fs.existsSync(path.join(directory, name)));
    if (!file) throw new Error(`Missing distribution license: ${meta.name}`);
    return `${meta.name}@${meta.version}\n${fs.readFileSync(path.join(directory, file), "utf8")}\n`;
  }).join("\n----------------------------------------\n\n");
};
export default {
  root: here,
  base: process.env.TRAVEL_BASE_PATH || "/",
  plugins: [react(), tailwind(), { name: "travel-distribution-notices", generateBundle() { this.emitFile({ type: "asset", fileName: "THIRD-PARTY-NOTICES.txt", source: notices() }); } }],
  resolve: { alias: [
    { find: "@", replacement: path.join(web, "src") },
    { find: "@vivic/contracts", replacement: path.resolve(here, "../../packages/contracts/src/index.ts") },
    { find: "node:crypto", replacement: path.join(here, "src/browser-crypto.ts") },
    ...["react", "react-dom", "lucide-react", "zod"].map(name => ({ find: new RegExp(`^${name}(/.*)?$`), replacement: path.join(web, "node_modules", name) + "$1" })),
  ] },
  server: { host: "127.0.0.1", port: 5196, strictPort: true, fs: { allow: [path.resolve(here, "../..")] } },
  build: { outDir: "dist", emptyOutDir: true },
};
