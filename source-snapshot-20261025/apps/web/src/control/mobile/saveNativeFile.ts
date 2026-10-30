import { NATIVE_ORIGIN } from "./pairing";
interface NativeFiles { saveFile(id: string, name: string, mime: string, base64: string, sha256: string): void; cancelSave(id: string): void; isTrustedOrigin?(origin: string): boolean }
export const nativeFiles = () => {
  const bridge = (window as Window & { VivicAndroid?: NativeFiles }).VivicAndroid;
  if (window.location.origin === NATIVE_ORIGIN) return bridge;
  try { return bridge?.isTrustedOrigin?.(window.location.origin) === true ? bridge : undefined; }
  catch { return undefined; }
};

/** Original has already passed owner-scope + full SHA-256 verification in the client. */
export async function saveNativeFile(bytes: Uint8Array<ArrayBuffer>, name: string, mime: string, sha256: string, signal: AbortSignal): Promise<void> {
  const bridge = nativeFiles();
  if (!bridge?.saveFile || bytes.length > 10_000_000 || /[\p{Cc}/\\]/u.test(name) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("此版本暂不支持原件保存");
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 16384) parts.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
  const encoded = btoa(parts.join("")), id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => { window.removeEventListener("vivic:file-save-result", received); signal.removeEventListener("abort", aborted); clearTimeout(timer); };
    const aborted = () => { cleanup(); bridge.cancelSave(id); reject(new Error("保存已取消")); };
    const received = (event: Event) => {
      const value = (event as CustomEvent<{ id?: string; ok?: boolean; error?: string }>).detail;
      if (!value || value.id !== id) return;
      cleanup(); if (value.ok === true) resolve(); else reject(new Error(value.error || "原文件尚未保存"));
    };
    const timer = setTimeout(aborted, 180_000);
    window.addEventListener("vivic:file-save-result", received); signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    bridge.saveFile(id, name, mime, encoded, sha256);
  });
}
