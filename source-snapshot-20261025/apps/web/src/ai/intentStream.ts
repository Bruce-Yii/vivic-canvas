import { z } from "zod";
import { ActionEnvelopeSchema } from "@/contracts";
import { HostOperationSchema, DecisionTaskStatusSchema } from "@vivic/contracts";

export const IntentProgressSchema = z.object({
  requestId: z.string().min(1).max(128),
  stage: z.enum(["rules", "data", "search", "decision", "planner", "validation", "travel", "total"]),
  status: z.enum(["started", "completed", "failed"]),
  elapsedMs: z.number().finite().nonnegative().optional(),
});
export type IntentProgress = z.infer<typeof IntentProgressSchema>;
export const intentStageLabel = (stage: IntentProgress["stage"]): string => ({
  rules: "正在匹配本地指令…", data: "正在获取所需数据…", search: "正在检索资料…",
  decision: "正在判断操作…", planner: "正在整理卡片内容…", validation: "正在校验结果…",
  travel: "正在查询旅游结果…", total: "正在完成处理…",
})[stage];

export const IntentResultSchema = z.object({
  kind: z.enum(["envelope", "clarify", "unknown", "error", "locale", "host-operation", "task"]),
  hostOperation: HostOperationSchema.optional(), task: DecisionTaskStatusSchema.optional(),
  envelope: ActionEnvelopeSchema.optional(), message: z.string().max(400).optional(),
  suggestions: z.array(z.string().max(100)).max(5).optional(),
  locale: z.object({ name: z.string(), admin1: z.string().optional(), country: z.string().optional(),
    basis: z.enum(["device", "network"]), answer: z.string() }).optional(),
  usedProvider: z.enum(["rules", "stepfun", "gpt", "rules-offline", "search", "decision"]).optional(),
}).refine(result => result.kind !== "envelope" || Boolean(result.envelope), "缺少已校验的操作")
  .refine(result => result.kind !== "host-operation" || Boolean(result.hostOperation && result.task?.status === "awaiting_execution"), "缺少宿主操作任务")
  .refine(result => !(result.envelope && result.hostOperation), "操作类型冲突");

/** Progress is advisory. Only one complete, schema-valid result leaves this parser. */
export async function readIntentStream(response: Response, onProgress: (event: IntentProgress) => void, signal?: AbortSignal) {
  if (!response.ok) throw new Error(`api ${response.status}`);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return IntentResultSchema.parse(await response.json());
  if (!response.body) throw new Error("指令响应为空");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", requestId: string | undefined;
  const accepted = z.object({ requestId: z.string().min(1).max(128) });
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 2 * 1024 * 1024) throw new Error("指令响应过大");
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = frame.split(/\r?\n/);
        const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
        const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (event === "accepted") {
          const next = accepted.parse(JSON.parse(data)).requestId;
          if (requestId && next !== requestId) throw new Error("指令响应会话不一致");
          requestId = next;
        } else if (event === "progress") {
          const parsed = IntentProgressSchema.safeParse(JSON.parse(data));
          if (parsed.success && requestId && parsed.data.requestId === requestId) {
            try { onProgress(parsed.data); } catch { /* UI observation cannot cancel a request. */ }
          }
        } else if (event === "result") {
          if (!requestId) throw new Error("指令响应缺少会话标识");
          return IntentResultSchema.parse(JSON.parse(data));
        }
      }
      if (done) throw new Error("指令响应提前结束，请重试。");
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
