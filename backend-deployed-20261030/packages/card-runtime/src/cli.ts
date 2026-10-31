import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parsePackageFiles, readPackageZip } from "./index";
import { readPackageDirectory } from "./nodeFiles";

try {
  const target = process.argv[2];
  if (!target || process.argv.length !== 3) throw new Error("用法: pnpm card:check <目录|文件.vivicard>");
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), target), stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error("不支持符号链接");
  let definition;
  if (stat.isDirectory()) {
    definition = await parsePackageFiles(await readPackageDirectory(path));
  } else {
    if (stat.size > 1048576) throw new Error("压缩包超过 1 MiB");
    definition = await readPackageZip(await readFile(path));
  }
  console.log(JSON.stringify({ valid: true, id: definition.manifest.id, version: definition.manifest.version, hash: definition.hash, examples: definition.examples.length, live: "unsupported" }, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
