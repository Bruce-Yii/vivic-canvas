import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ConnectionManager, type ConnectionPlanner } from "./manager.js";
import { ConnectionError, ProviderSchema } from "./types.js";

const ProviderRequest = z.object({ provider: ProviderSchema }).strict();
const QueryRequest = z.object({ provider: ProviderSchema, tool: z.string().regex(/^[\w.\/-]{1,128}$/), args: z.record(z.string(), z.unknown()).default({}) }).strict();
const AskRequest = z.object({ provider: ProviderSchema, question: z.string().trim().min(1).max(2000) }).strict();
export function createConnectionRoutes(manager: ConnectionManager, planner?: ConnectionPlanner) {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 32 * 1024, onError: c => c.json({ ok: false, code: "connection-body-too-large", error: "连接请求过大。" }, 413) }));
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.get("/status", c => c.json({ ok: true, connections: manager.status() }));
  for (const action of ["configure", "test", "disconnect", "query", "ask"] as const) app.post(`/${action}`, async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "请求格式不正确。" }, 400); }
    try {
      if (action === "configure") return c.json({ ok: true, connections: manager.configure(body) });
      if (action === "ask") {
        const request = AskRequest.safeParse(body);
        if (!request.success) throw new ConnectionError("invalid-question", "请输入简短的查询问题。");
        if (!planner) throw new ConnectionError("planner-unavailable", "请先连接语言模型，或使用指定查询。", 409);
        return c.json({ ok: true, result: await manager.ask(request.data.provider, request.data.question, planner, c.req.raw.signal) });
      }
      if (action === "query") {
        const request = QueryRequest.safeParse(body);
        if (!request.success) throw new ConnectionError("invalid-query", "查询参数格式不正确。");
        return c.json({ ok: true, result: await manager.query(request.data.provider, request.data.tool, request.data.args, c.req.raw.signal) });
      }
      const request = ProviderRequest.safeParse(body);
      if (!request.success) throw new ConnectionError("invalid-provider", "请选择要操作的连接。");
      return c.json({ ok: true, connections: action === "test" ? await manager.test(request.data.provider, c.req.raw.signal) : manager.disconnect(request.data.provider) });
    } catch (error) {
      const failure = error instanceof ConnectionError ? error : new ConnectionError("connection-failed", "服务暂时无法完成请求。", 502);
      return c.json({ ok: false, code: failure.code, error: failure.message }, failure.status);
    }
  });
  return app;
}
