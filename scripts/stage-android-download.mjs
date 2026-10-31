import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Stage a verified release APK before Vite copies public assets. Never use a debug package. */
export async function stageAndroidDownload(root) {
  const manifest = await fs.readFile(path.join(root, "apps/android/AndroidManifest.xml"), "utf8");
  const version = manifest.match(/android:versionName="([0-9.]+)"/)?.[1];
  if (!version) throw new Error("Missing Android release version.");
  const source = path.resolve(root, process.env.VIVIC_ANDROID_APK || `.cache/android-build/artifacts/Vivic-Remote-${version}.apk`);
  const receipt = JSON.parse(await fs.readFile(`${source}.json`, "utf8"));
  const apk = await fs.readFile(source);
  const sha256 = createHash("sha256").update(apk).digest("hex");
  if (receipt.debugging !== false || receipt.testCa !== false || receipt.sha256 !== sha256 || receipt.apk !== `Vivic-Remote-${version}.apk`) {
    throw new Error("Android download must be the matching verified production APK; debug/test-CA or mismatched artifacts are refused.");
  }
  const require = createRequire(path.join(root, "apps/local-api/package.json"));
  const { unzipSync } = require("fflate");
  const entries = unzipSync(apk);
  const binaryManifest = Buffer.from(entries["AndroidManifest.xml"] ?? []);
  if (!entries["classes.dex"] || !entries["assets/web/index.html"] || binaryManifest.length < 100 ||
      Object.keys(entries).some(name => /vivic_test|debug.*security/i.test(name)) ||
      ["debuggable", "networkSecurityConfig"].some(name => binaryManifest.includes(Buffer.from(name)) || binaryManifest.includes(Buffer.from(name, "utf16le")))) {
    throw new Error("Android download contains test trust/debug configuration or is not a complete Vivic package.");
  }
  const directory = path.join(root, "apps/web/public/downloads");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "Vivic-Remote.apk"), apk);
  const metadata = { version, file: "Vivic-Remote.apk", bytes: apk.length, sha256, signing: receipt.signing };
  await fs.writeFile(path.join(directory, "android.json"), JSON.stringify(metadata, null, 2));
  return metadata;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.info(JSON.stringify(await stageAndroidDownload(fileURLToPath(new URL("../", import.meta.url)))));
}
