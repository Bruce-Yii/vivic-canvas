import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { ProviderClient } from "./client.js";
import type { ProviderStore } from "./store.js";
import {
  CreateProviderSchema, PROVIDER_PRESETS, PROVIDER_ROLES, ProviderBaseUrlSchema, ProviderProtocolSchema,
  ProviderRoleSchema, UpdateProviderSchema, type ProviderErrorType, type ProviderRole,
} from "./types.js";

/**
 * Provider management endpoints.
 *
 * Mounted at /api/providers. These coexist with the legacy single-provider
 * endpoints (/api/providers/status, /api/providers/select, /api/providers/model)
 * which stay registered first so existing clients are unaffected.
 */

const TestBody = z.strictObject({
  model: z.string().trim().min(1).max(200).optional(),
  baseUrl: ProviderBaseUrlSchema.optional(),
  protocol: ProviderProtocolSchema.optional(),
  apiKey: z.string().min(1).max(4096).optional(),
  /** Unsaved edits may change the roles, and the probe route follows them. */
  roles: z.array(ProviderRoleSchema).max(5).optional(),
}).strict();

const ModelsBody = z.strictObject({
  baseUrl: ProviderBaseUrlSchema.optional(),
  protocol: ProviderProtocolSchema.optional(),
  apiKey: z.string().min(1).max(4096).optional(),
}).strict();

/** A not-yet-saved provider: the user must be able to list models and test
 *  connectivity before committing anything to disk. */
const DraftSchema = z.strictObject({
  presetId: z.string().max(64).optional(),
  name: z.string().trim().max(64).optional(),
  protocol: ProviderProtocolSchema,
  baseUrl: ProviderBaseUrlSchema,
  apiKey: z.string().min(1).max(4096).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  headers: z.record(z.string().max(64), z.string().max(2048)).optional(),
  /** Drives the probe route: a pure-ASR draft must be tested on transcriptions. */
  roles: z.array(z.string().max(16)).max(5).optional(),
});

const draftToConfig = (draft: z.infer<typeof DraftSchema>) => ({
  id: "draft",
  name: draft.name ?? "draft",
  kind: "custom" as const,
  ...(draft.presetId ? { presetId: draft.presetId } : {}),
  protocol: draft.protocol,
  baseUrl: draft.baseUrl.replace(/\/+$/, ""),
  ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
  ...(draft.model ? { model: draft.model } : {}),
  ...(draft.headers ? { headers: draft.headers } : {}),
  // Keep only roles this build knows; the probe picks its route from them.
  roles: (draft.roles ?? []).filter((role): role is ProviderRole => (PROVIDER_ROLES as readonly string[]).includes(role)),
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const errorTypeStatus: Record<ProviderErrorType, number> = {
  auth: 401,
  "not-found": 404,
  protocol: 400,
  unsupported: 400,
  timeout: 504,
  network: 502,
  "invalid-response": 502,
  unknown: 502,
};

const readJson = async (c: { req: { json: () => Promise<unknown> } }): Promise<unknown> =>
  c.req.json().catch(() => null);

const issueText = (error: z.ZodError): string =>
  error.issues.slice(0, 2).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("；");

export interface ProviderRoutesDeps {
  store: ProviderStore;
  client?: ProviderClient;
}

export function createProviderRoutes({ store, client }: ProviderRoutesDeps): Hono {
  const app = new Hono();
  const providerClient = client ?? new ProviderClient();

  app.use("*", bodyLimit({
    maxSize: 32 * 1024,
    onError: (c) => c.json({ ok: false, error: "请求体过大。" }, 413),
  }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  /** Preset catalogue so the UI never hard-codes platform knowledge. */
  app.get("/presets", (c) => c.json({ ok: true, presets: PROVIDER_PRESETS }));

  // Draft endpoints are registered BEFORE /:id/* so an unsaved configuration
  // can list models and test connectivity without being persisted first.
  app.post("/preview/models", async (c) => {
    const parsed = DraftSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ ok: false, error: `参数无效：${issueText(parsed.error)}` }, 400);
    const result = await providerClient.fetchModels(draftToConfig(parsed.data), { signal: c.req.raw.signal });
    if (!result.ok) {
      return c.json({ ok: false, error: result.error,
        ...(result.errorType ? { errorType: result.errorType } : {}) },
        errorTypeStatus[result.errorType ?? "unknown"] as ContentfulStatusCode);
    }
    return c.json({ ok: true, models: result.models,
      ...(result.fallback ? { fallback: true } : {}),
      ...(result.error ? { note: result.error } : {}) });
  });

  app.post("/preview/test", async (c) => {
    const parsed = DraftSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ ok: false, error: `参数无效：${issueText(parsed.error)}` }, 400);
    const result = await providerClient.testConnection(draftToConfig(parsed.data), { signal: c.req.raw.signal });
    const models = result.ok ? await providerClient.fetchModels(draftToConfig(parsed.data), { signal: c.req.raw.signal }) : undefined;
    const modelCount = models?.ok ? models.models?.length : undefined;
    return c.json({
      ok: result.ok,
      ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
      ...(result.model ? { model: result.model } : {}),
      ...(modelCount !== undefined ? { models: modelCount } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.errorType ? { errorType: result.errorType } : {}),
      ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
    }, result.ok ? 200 : errorTypeStatus[result.errorType ?? "unknown"] as ContentfulStatusCode);
  });

  app.get("/", (c) => c.json({ ok: true, providers: store.statusAll() }));

  app.post("/", async (c) => {
    const body = await readJson(c);
    const parsed = CreateProviderSchema.safeParse(body);
    if (!parsed.success) return c.json({ ok: false, error: `配置无效：${issueText(parsed.error)}` }, 400);
    try {
      const config = store.create(parsed.data);
      return c.json({ ok: true, provider: store.view(config) }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "创建失败。";
      return c.json({ ok: false, error: message }, 400);
    }
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!store.get(id)) return c.json({ ok: false, error: "Provider 不存在。" }, 404);
    const body = await readJson(c);
    const parsed = UpdateProviderSchema.safeParse(body);
    if (!parsed.success) return c.json({ ok: false, error: `配置无效：${issueText(parsed.error)}` }, 400);
    try {
      const config = store.update(id, parsed.data);
      return c.json({ ok: true, provider: store.view(config) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新失败。";
      return c.json({ ok: false, error: message }, 400);
    }
  });

  app.delete("/:id", (c) => {
    const id = c.req.param("id");
    if (!store.delete(id)) return c.json({ ok: false, error: "Provider 不存在。" }, 404);
    return c.json({ ok: true });
  });

  /**
   * Real inference probe. The request body may override the stored model /
   * endpoint / key so the UI can test unsaved edits without persisting them.
   */
  app.post("/:id/test", async (c) => {
    const id = c.req.param("id");
    const existing = store.get(id);
    if (!existing) return c.json({ ok: false, error: "Provider 不存在。" }, 404);
    const body = await readJson(c);
    const parsed = TestBody.safeParse(body ?? {});
    if (!parsed.success) return c.json({ ok: false, error: `测试参数无效：${issueText(parsed.error)}` }, 400);

    const config = {
      ...existing,
      ...(parsed.data.baseUrl ? { baseUrl: parsed.data.baseUrl.replace(/\/+$/, "") } : {}),
      ...(parsed.data.protocol ? { protocol: parsed.data.protocol } : {}),
      ...(parsed.data.apiKey ? { apiKey: parsed.data.apiKey } : {}),
      ...(parsed.data.model ? { model: parsed.data.model } : {}),
      ...(parsed.data.roles ? { roles: parsed.data.roles } : {}),
    };

    const result = await providerClient.testConnection(config, { signal: c.req.raw.signal });
    const models = result.ok ? await providerClient.fetchModels(config, { signal: c.req.raw.signal }) : undefined;
    const modelCount = models?.ok ? models.models?.length : undefined;

    // Only persist runtime status for the stored configuration.
    if (!parsed.data.baseUrl && !parsed.data.protocol && !parsed.data.apiKey && !parsed.data.model) {
      store.recordTest(id, {
        connected: result.ok,
        ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
        lastCheckedAt: new Date().toISOString(),
        ...(result.error ? { lastError: result.error } : {}),
        ...(result.errorType ? { errorType: result.errorType } : {}),
        ...(modelCount !== undefined ? { models: modelCount } : {}),
      });
    }

    const status = result.ok ? 200 : errorTypeStatus[result.errorType ?? "unknown"] as ContentfulStatusCode;
    return c.json({
      ok: result.ok,
      ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
      ...(result.model ? { model: result.model } : {}),
      ...(modelCount !== undefined ? { models: modelCount } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.errorType ? { errorType: result.errorType } : {}),
      ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
    }, result.ok ? 200 : status);
  });

  /**
   * Proxy GET {baseUrl}/models. Falls back to the preset's static list, so the
   * user still gets selectable models on platforms without a catalog endpoint.
   */
  app.post("/:id/models", async (c) => {
    const id = c.req.param("id");
    const existing = store.get(id);
    if (!existing) return c.json({ ok: false, error: "Provider 不存在。" }, 404);
    const body = await readJson(c);
    const parsed = ModelsBody.safeParse(body ?? {});
    if (!parsed.success) return c.json({ ok: false, error: `参数无效：${issueText(parsed.error)}` }, 400);

    const config = {
      ...existing,
      ...(parsed.data.baseUrl ? { baseUrl: parsed.data.baseUrl.replace(/\/+$/, "") } : {}),
      ...(parsed.data.protocol ? { protocol: parsed.data.protocol } : {}),
      ...(parsed.data.apiKey ? { apiKey: parsed.data.apiKey } : {}),
    };

    const result = await providerClient.fetchModels(config, { signal: c.req.raw.signal });
    if (!result.ok) {
      return c.json({
        ok: false,
        error: result.error,
        ...(result.errorType ? { errorType: result.errorType } : {}),
      }, errorTypeStatus[result.errorType ?? "unknown"] as ContentfulStatusCode);
    }
    return c.json({
      ok: true,
      models: result.models,
      ...(result.fallback ? { fallback: true } : {}),
      ...(result.error ? { note: result.error } : {}),
    });
  });

  return app;
}
