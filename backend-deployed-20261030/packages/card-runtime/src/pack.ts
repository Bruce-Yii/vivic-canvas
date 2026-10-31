import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { zipSync } from "fflate";
import { parsePackageFiles, readPackageZip } from "./index";
import { readPackageDirectory } from "./nodeFiles";

try {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination || process.argv.length !== 4) throw new Error("用法: pnpm card:pack <目录> <输出.vivicard>");
  const base = process.env.INIT_CWD ?? process.cwd();
  const input = resolve(base, source), output = resolve(base, destination);
  if (!output.endsWith(".vivicard")) throw new Error("输出文件必须使用 .vivicard 扩展名");
  const files = await readPackageDirectory(input), definition = await parsePackageFiles(files);
  // Entries always use portable '/' separators, including on Windows.
  const bytes = zipSync(files, { level: 6 }), checked = await readPackageZip(bytes);
  if (checked.hash !== definition.hash) throw new Error("打包后的内容身份不一致");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes, { flag: "wx" });
  console.log(JSON.stringify({ valid: true, path: output, hash: checked.hash, bytes: bytes.length }, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
