import { downloadModel } from "./download";
import { getSpeechModel, MODEL_IDS } from "./models";
import { IndexedDbModelStorage, matchesModel } from "./storage";
import type { ModelRequest, ModelResponse } from "./protocol";
import type { ModelId } from "./types";

const scope = self as unknown as { onmessage: ((event: MessageEvent<ModelRequest>) => void) | null; postMessage: (data: ModelResponse) => void };
const storage = new IndexedDbModelStorage();
const controllers = new Map<number, AbortController>();
scope.onmessage = event => {
  const message = event.data;
  if (message.op === "cancel") { controllers.get(message.target)?.abort(); return; }
  const controller = new AbortController();
  controllers.set(message.id, controller);
  void (async () => {
    if (message.op === "prepare") {
      await downloadModel(getSpeechModel(message.modelId), { storage, signal: controller.signal,
        onProgress: state => scope.postMessage({ id: message.id, type: "progress", state }),
      });
      scope.postMessage({ id: message.id, type: "done" });
    } else if (message.op === "clear") {
      await storage.delete(message.modelId);
      scope.postMessage({ id: message.id, type: "done" });
    } else {
      const cached: ModelId[] = [];
      for (const id of MODEL_IDS) if (matchesModel(await storage.get(id), getSpeechModel(id))) cached.push(id);
      scope.postMessage({ id: message.id, type: "done", cached });
    }
  })().catch(error => scope.postMessage({ id: message.id, type: "error", aborted: controller.signal.aborted,
    message: error instanceof Error ? error.message : "模型操作失败，请使用 PTT 或文字。",
  })).finally(() => controllers.delete(message.id));
};
