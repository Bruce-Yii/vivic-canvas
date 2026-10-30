import { FILE_CHUNK_BYTES, type CanvasSnapshot, type Frame, type Welcome } from "./protocol";

export interface DownloadedFile { bytes: Uint8Array<ArrayBuffer>; name: string; mediaType: string }
interface Transfer {
  requestId: string; cardId: string; imageId?: string; canvasId: string; ownerEpoch: string; version: number; sessionId: string; epoch: string; offset: number; bytes: Uint8Array<ArrayBuffer>;
  sha256: string; name: string; mediaType: string; timer: ReturnType<typeof setTimeout> | null; started: number; lastSent: number;
  resolve(value: DownloadedFile): void; reject(error: Error): void; cleanup(): void; progress?(received: number, total: number): void;
}
/** One bounded in-memory original at a time; reads never enter the write ledger or canvas DB. */
export function createFileClient(options: { context(): { welcome: Welcome; snapshot: CanvasSnapshot; deviceId: string } | null; send(frame: Frame): boolean; now(): number; minimumChunkDelayMs?: number }) {
  const descriptor = (snapshot: CanvasSnapshot | undefined, cardId: string, imageId?: string) => {
    const card = snapshot?.cards.find(card => card.id === cardId);
    return imageId ? card?.images?.find(image => image.id === imageId) : card?.file;
  };
  let transfer: Transfer | null = null;
  const cancel = (message: string) => {
    const current = transfer; transfer = null;
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    current.cleanup(); current.reject(new Error(message));
  };
  const currentScope = (current: Transfer) => {
    const context = options.context(), snapshot = context?.snapshot, file = descriptor(snapshot, current.cardId, current.imageId);
    return Boolean(context && context.welcome.sessionId === current.sessionId && context.welcome.epoch === current.epoch && context.welcome.permissions.includes(current.imageId ? "image.read" : "file.read")
      && snapshot?.ownerAvailable && snapshot.activeCanvasId === current.canvasId && snapshot.ownerEpoch === current.ownerEpoch && snapshot.version === current.version
      && file && file.sha256 === current.sha256 && file.sizeBytes === current.bytes.length && file.name === current.name && file.mediaType === current.mediaType);
  };
  const next = () => {
    const current = transfer, context = options.context();
    if (!current || !context || !currentScope(current) || options.now() - current.started > 180_000) { cancel("文件下载已中断，请重试"); return; }
    if (current.timer) clearTimeout(current.timer);
    // Preserve existing relay message limits even for a full 10 MB original.
    const delay = (options.minimumChunkDelayMs ?? 180) - (options.now() - current.lastSent);
    if (delay > 0) { current.timer = setTimeout(next, delay); return; }
    current.lastSent = options.now();
    current.timer = setTimeout(() => cancel("读取文件超时，请重试"), 15_000);
    if (!options.send({ v: 1, type: "file.request", sessionId: context.welcome.sessionId, epoch: context.welcome.epoch, deviceId: context.deviceId,
      requestId: current.requestId, cardId: current.cardId, ...(current.imageId ? { imageId: current.imageId } : {}), canvasId: current.canvasId, ownerEpoch: current.ownerEpoch, expectedVersion: current.version, offset: current.offset })) cancel("文件请求发送失败");
  };
  return {
    cancel,
    reconcile() { if (transfer && !currentScope(transfer)) cancel("文件或控制会话已变化，下载已取消"); },
    read(cardId: string, progress?: Transfer["progress"], signal?: AbortSignal, imageId?: string): Promise<DownloadedFile> {
      const context = options.context(), snapshot = context?.snapshot, file = descriptor(snapshot, cardId, imageId);
      if (transfer || !snapshot?.ownerAvailable || !snapshot.activeCanvasId || !context?.welcome.permissions.includes(imageId ? "image.read" : "file.read") || !file || signal?.aborted) return Promise.reject(new Error(imageId ? "图片尚不可读取，请检查电脑连接或等待上一项完成" : "文件尚不可下载，请检查电脑连接"));
      return new Promise((resolve, reject) => {
        const abort = () => cancel("下载已取消"); signal?.addEventListener("abort", abort, { once: true });
        transfer = { requestId: crypto.randomUUID(), cardId, ...(imageId ? { imageId } : {}), canvasId: snapshot.activeCanvasId!, ownerEpoch: snapshot.ownerEpoch, version: snapshot.version,
          sessionId: context.welcome.sessionId, epoch: context.welcome.epoch,
          offset: 0, bytes: new Uint8Array(file.sizeBytes), sha256: file.sha256, name: file.name, mediaType: file.mediaType,
          timer: null, started: options.now(), lastSent: 0, resolve, reject, progress, cleanup: () => signal?.removeEventListener("abort", abort) };
        next();
      });
    },
    receive(frame: Frame): boolean {
      const current = transfer, context = options.context();
      if (!current || !context || !("requestId" in frame) || frame.requestId !== current.requestId) return false;
      if (frame.type === "error") { cancel("电脑未能读取原文件，请同步后重试"); return true; }
      if (!("sessionId" in frame) || frame.sessionId !== context.welcome.sessionId || frame.epoch !== context.welcome.epoch || frame.deviceId !== context.welcome.computerId
        || !("forDeviceId" in frame) || frame.forDeviceId !== context.deviceId) return false;
      if (frame.type === "file.error") { cancel(frame.message); return true; }
      if (frame.type !== "file.chunk") return false;
      if (!currentScope(current)) { cancel("文件或控制会话已变化，下载已取消"); return true; }
      try {
        const chunk = frame.chunk, decoded = Uint8Array.from(atob(chunk.data), value => value.charCodeAt(0));
        if (frame.cardId !== current.cardId || frame.offset !== current.offset || chunk.totalBytes !== current.bytes.length || chunk.sha256 !== current.sha256
          || chunk.name !== current.name || chunk.mediaType !== current.mediaType || decoded.length > FILE_CHUNK_BYTES || current.offset + decoded.length > current.bytes.length
          || decoded.length === 0 && current.offset < current.bytes.length) throw new Error("invalid_file_chunk");
        current.bytes.set(decoded, current.offset); current.offset += decoded.length;
        try { current.progress?.(current.offset, current.bytes.length); } catch { /* Observation cannot alter download validation. */ }
        if (current.offset < current.bytes.length) next();
        else {
          if (current.timer) clearTimeout(current.timer);
          void crypto.subtle.digest("SHA-256", current.bytes).then(hash => {
            if (transfer !== current) return;
            if (!currentScope(current)) { cancel("文件或控制会话已变化，下载已取消"); return; }
            const checksum = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
            if (checksum !== current.sha256) { cancel("文件完整性校验失败，请重新下载"); return; }
            transfer = null; current.cleanup(); current.resolve({ bytes: current.bytes, name: current.name, mediaType: current.mediaType });
          }).catch(() => cancel("无法校验原文件完整性"));
        }
      } catch { cancel("文件分段响应无效，下载已停止"); }
      return true;
    },
  };
}
