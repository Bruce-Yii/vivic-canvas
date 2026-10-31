import { lstat, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PACKAGE_LIMITS } from "./index";

/** Node-only package tooling. Keep this outside the browser runtime entry. */
export async function readPackageDirectory(folder: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  const root = await lstat(folder);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("需要普通目录，不支持符号链接");
  const scan = async (directory: string, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name, absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${relative}: 不支持符号链接`);
      if (entry.isDirectory() && relative === "examples") await scan(absolute, "examples/");
      else if (entry.isFile()) {
        const stat = await lstat(absolute);
        if (Object.keys(files).length >= PACKAGE_LIMITS.files || stat.size > PACKAGE_LIMITS.fileBytes
          || total + stat.size > PACKAGE_LIMITS.totalBytes) throw new Error(`${relative}: 文件数/大小超过限制`);
        const bytes = await readFile(absolute);
        total += bytes.length;
        if (bytes.length > PACKAGE_LIMITS.fileBytes || total > PACKAGE_LIMITS.totalBytes) throw new Error(`${relative}: 文件读取后超过大小限制`);
        files[relative] = bytes;
      } else throw new Error(`${relative}: 不支持的目录或文件`);
    }
  };
  await scan(folder);
  return files;
}
