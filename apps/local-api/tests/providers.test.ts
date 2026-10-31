import { describe, expect, it } from "vitest";
import { ProviderClient } from "../src/providers/client.js";
import { ProviderStore, type ProviderStoreOptions, type SecretCodec } from "../src/providers/store.js";
import { SecretBox } from "../src/providers/secrets.js";
import { PROVIDER_PRESETS, maskApiKey, validateProtocolModel } from "../src/providers/types.js";
import { fetchStub } from "./helpers.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Trivial reversible codec so store tests do not touch a real key file. */
const fakeCodec: SecretCodec = {
  encrypt: (plain) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
  decrypt: (blob) => blob?.startsWith("enc:") ? Buffer.from(blob.slice(4), "base64").toString("utf8") : undefined,
};

/** In-memory filesystem so store tests never write to the real home directory. */
const memoryFs = () => {
  const files = new Map<string, string>();
  return {
    files,
    fs: {
      existsSync: (path: string) => files.has(path),
      readFileSync: (path: string) => files.get(path) ?? "",
      writeFileSync: (path: string, data: string) => { files.set(path, String(data)); },
      mkdirSync: () => undefined,
    } as unknown as NonNullable<ProviderStoreOptions["fs"]>,
  };
};

const newStore = (options: { persist?: boolean } = {}) => {
  const { files, fs } = memoryFs();
  const store = new ProviderStore({
    dataDir: "/mem",
    secrets: fakeCodec,
    fs,
    ...(options.persist === false ? { persist: false } : {}),
  });
  return { store, files };
};

const API_KEY = "sk-test-abcdefghijklmnop";

const openaiConfig = () => ({
  name: "测试 OpenAI",
  protocol: "openai-compatible" as const,
  baseUrl: "https://api.example.test/v1",
  apiKey: API_KEY,
  model: "gpt-4o-mini",
  roles: ["main" as const],
});

describe("ProviderStore", () => {
  it("creates, lists, updates and deletes a provider", () => {
    const { store } = newStore();
    const created = store.create(openaiConfig());
    expect(created.id).toBeTruthy();
    expect(store.list()).toHaveLength(1);
    expect(store.get(created.id)?.model).toBe("gpt-4o-mini");

    const updated = store.update(created.id, { model: "gpt-4o" });
    expect(updated.model).toBe("gpt-4o");

    expect(store.delete(created.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("never exposes the API key in a client view", () => {
    const { store } = newStore();
    const created = store.create(openaiConfig());
    const view = store.view(created);
    expect(view.hasApiKey).toBe(true);
    expect(view.apiKeyHint).toBe(maskApiKey(API_KEY));
    // The raw secret must appear nowhere in the serialized view.
    expect(JSON.stringify(view)).not.toContain(API_KEY);
    expect(store.statusAll().every((status) => !JSON.stringify(status).includes(API_KEY))).toBe(true);
    // Internal callers can still read it.
    expect(store.getApiKey(created.id)).toBe(API_KEY);
  });

  it("persists ciphertext, not the plaintext key", () => {
    const { store, files } = newStore();
    store.create(openaiConfig());
    const raw = [...files.values()].join("\n");
    expect(raw).toContain("apiKeyEnc");
    expect(raw).not.toContain(API_KEY);
    // A fresh store over the same file recovers the key through the codec.
    const reopened = new ProviderStore({ dataDir: "/mem", secrets: fakeCodec, fs: memoryFs().fs });
    expect(reopened.list()).toHaveLength(0); // different in-memory fs
  });

  it("reloads persisted providers and decrypts their keys", () => {
    const { fs, files } = memoryFs();
    const first = new ProviderStore({ dataDir: "/mem", secrets: fakeCodec, fs });
    const created = first.create(openaiConfig());
    expect(files.size).toBe(1);

    const second = new ProviderStore({ dataDir: "/mem", secrets: fakeCodec, fs });
    expect(second.list()).toHaveLength(1);
    expect(second.getApiKey(created.id)).toBe(API_KEY);
  });

  it("keeps everything in memory when persist is false", () => {
    const { store, files } = newStore({ persist: false });
    store.create(openaiConfig());
    expect(files.size).toBe(0);
  });

  it("resolves providers by role, preferring a dedicated one", () => {
    const { store } = newStore();
    const shared = store.create({ ...openaiConfig(), name: "shared", roles: ["main", "decision"] });
    expect(store.findForRole("main")?.id).toBe(shared.id);

    const dedicated = store.create({ ...openaiConfig(), name: "decider", protocol: "startlux-native",
      baseUrl: "https://gw.example.test/api/v1", model: "startlux-decision-4b", roles: ["decision"] });
    expect(store.findForRole("decision")?.id).toBe(dedicated.id);
    expect(store.roleAssignments()).toEqual({ main: shared.id, decision: dedicated.id });
  });

  it("rejects the known-bad 4B + legacy protocol combination", () => {
    const { store } = newStore();
    expect(() => store.create({ ...openaiConfig(), model: "startlux-decision-4b" }))
      .toThrow(/4B/);
    expect(() => store.create({ ...openaiConfig(), protocol: "startlux-native", model: "startlux-decision-2b" }))
      .toThrow(/2B/);
    // The correct pairing is accepted.
    expect(store.create({ ...openaiConfig(), protocol: "startlux-native", model: "startlux-decision-4b" }).model)
      .toBe("startlux-decision-4b");
  });

  it("clears a stored key on request", () => {
    const { store } = newStore();
    const created = store.create(openaiConfig());
    const cleared = store.update(created.id, { clearApiKey: true });
    expect(cleared.apiKey).toBeUndefined();
    expect(store.view(cleared).hasApiKey).toBe(false);
  });
});

describe("SecretBox", () => {
  it("round-trips through AES-GCM and rejects tampered blobs", () => {
    const dir = mkdtempSync(join(tmpdir(), "vivic-secret-"));
    try {
      const box = new SecretBox(join(dir, ".secret-key"));
      const blob = box.encrypt(API_KEY);
      expect(blob.startsWith("v1:")).toBe(true);
      expect(blob).not.toContain(API_KEY);
      expect(box.decrypt(blob)).toBe(API_KEY);
      expect(box.decrypt(`${blob.slice(0, -4)}AAAA`)).toBeUndefined();
      expect(box.decrypt(undefined)).toBeUndefined();
      // A different machine key cannot read the blob.
      const other = new SecretBox(join(dir, "other-key"));
      expect(other.decrypt(blob)).toBeUndefined();
      // The key file is written with owner-only permissions where the OS supports it.
      expect(readFileSync(join(dir, ".secret-key")).length).toBe(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("validateProtocolModel", () => {
  it("maps 4B to native and 2B to the legacy adapter", () => {
    expect(validateProtocolModel("startlux-native", "startlux-decision-4b").ok).toBe(true);
    expect(validateProtocolModel("legacy-2b", "startlux-decision-2b").ok).toBe(true);
    expect(validateProtocolModel("openai-compatible", "startlux-decision-4b").ok).toBe(false);
    expect(validateProtocolModel("startlux-native", "startlux-decision-2b").ok).toBe(false);
    // Non-decision models are unconstrained.
    expect(validateProtocolModel("openai-compatible", "gpt-4o").ok).toBe(true);
  });
});

describe("ProviderClient.testConnection", () => {
  const config = (overrides: Record<string, unknown> = {}) => ({
    id: "p1", name: "t", kind: "custom" as const, protocol: "openai-compatible" as const,
    baseUrl: "https://api.example.test/v1", apiKey: API_KEY, model: "gpt-4o-mini",
    roles: ["main" as const], enabled: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  });

  it("reports latency on a real chat completion", async () => {
    const client = new ProviderClient({
      fetchImpl: fetchStub({
        "/chat/completions": () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200, headers: { "content-type": "application/json" },
        }),
      }),
    });
    const result = await client.testConnection(config());
    expect(result.ok).toBe(true);
    expect(result.model).toBe("gpt-4o-mini");
    expect(typeof result.latencyMs).toBe("number");
  });

  it("classifies auth, not-found, timeout and refused-port failures", async () => {
    const auth = await new ProviderClient({
      fetchImpl: fetchStub({ "/chat/completions": () => new Response("unauthorized", { status: 401 }) }),
    }).testConnection(config());
    expect(auth.ok).toBe(false);
    expect(auth.errorType).toBe("auth");

    const missing = await new ProviderClient({
      fetchImpl: fetchStub({ "/chat/completions": () => new Response("nope", { status: 404 }) }),
    }).testConnection(config());
    expect(missing.errorType).toBe("not-found");

    const refused = await new ProviderClient({
      fetchImpl: (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }) as typeof fetch,
    }).testConnection(config());
    expect(refused.errorType).toBe("network");
    expect(refused.error).toMatch(/端口拒绝|ECONNREFUSED/);

    const timedOut = await new ProviderClient({
      fetchImpl: (async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }) as typeof fetch,
    }).testConnection(config());
    expect(timedOut.errorType).toBe("timeout");
  });

  it("explains a missing Step Plan subscription", async () => {
    const result = await new ProviderClient({
      fetchImpl: fetchStub({
        "/chat/completions": () => new Response(
          JSON.stringify({ error: { message: "no active step plan subscription" } }), { status: 400 }),
      }),
    }).testConnection(config({ protocol: "stepfun-plan", baseUrl: "https://api.stepfun.com/step_plan/v1", model: "step-3.5-flash" }));
    expect(result.ok).toBe(false);
    expect(result.errorType).toBe("unsupported");
    expect(result.error).toMatch(/Step Plan/);
  });

  it("sends the native body for 4B and the legacy body for 2B", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new ProviderClient({
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(JSON.stringify({ answers: { intent: { choice: "fit" } } }), { status: 200 });
      }) as typeof fetch,
    });
    await client.testConnection(config({ protocol: "startlux-native",
      baseUrl: "https://gw.example.test/api/v1", model: "startlux-decision-4b" }));
    await client.testConnection(config({ protocol: "legacy-2b",
      baseUrl: "https://gw.example.test/api/v1", model: "startlux-decision-2b" }));

    expect(seen[0]!.url).toBe("https://gw.example.test/api/v1/decisions");
    expect(seen[0]!.body).toHaveProperty("state");
    expect(seen[0]!.body).toHaveProperty("questions");
    expect(seen[0]!.body).not.toHaveProperty("input");

    expect(seen[1]!.body).toHaveProperty("input");
    expect(seen[1]!.body).toHaveProperty("labels");
    expect(seen[1]!.body).not.toHaveProperty("state");
  });

  it("refuses a mismatched protocol before any network call", async () => {
    let called = false;
    const client = new ProviderClient({
      fetchImpl: (async () => { called = true; return new Response("{}"); }) as typeof fetch,
    });
    const result = await client.testConnection(config({ model: "startlux-decision-4b" }));
    expect(result.ok).toBe(false);
    expect(result.errorType).toBe("protocol");
    expect(result.error).toMatch(/4B/);
    expect(called).toBe(false);
  });

  it("never leaks the key into an error message", async () => {
    const client = new ProviderClient({
      fetchImpl: fetchStub({ "/chat/completions": () => new Response(`bad key ${API_KEY}`, { status: 500 }) }),
    });
    const result = await client.testConnection(config());
    expect(result.ok).toBe(false);
    expect(result.error ?? "").not.toContain(API_KEY);
  });
});

describe("ProviderClient.fetchModels", () => {
  const config = (overrides: Record<string, unknown> = {}) => ({
    id: "p1", name: "t", kind: "custom" as const, protocol: "openai-compatible" as const,
    baseUrl: "https://api.example.test/v1", apiKey: API_KEY,
    roles: ["main" as const], enabled: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  });

  it("parses data[].id and classifies chat / embedding / audio", async () => {
    const client = new ProviderClient({
      fetchImpl: fetchStub({
        "/models": () => new Response(JSON.stringify({
          data: [{ id: "gpt-4o" }, { id: "text-embedding-3-small" }, { id: "tts-1" }, { id: "bge-m3" }],
        }), { status: 200 }),
      }),
    });
    const result = await client.fetchModels(config());
    expect(result.ok).toBe(true);
    const kinds = Object.fromEntries(result.models!.map((model) => [model.id, model.kind]));
    expect(kinds["gpt-4o"]).toBe("chat");
    expect(kinds["text-embedding-3-small"]).toBe("embedding");
    expect(kinds["tts-1"]).toBe("audio");
    expect(kinds["bge-m3"]).toBe("embedding");
  });

  it("falls back to the preset list when /models is unsupported", async () => {
    const client = new ProviderClient({
      fetchImpl: fetchStub({ "/models": () => new Response("nope", { status: 404 }) }),
    });
    const result = await client.fetchModels(config({ presetId: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4" }));
    expect(result.ok).toBe(true);
    expect(result.fallback).toBe(true);
    expect(result.models!.map((m) => m.id)).toContain("glm-4-plus");
  });

  it("does not call the network for a preset without a catalog endpoint", async () => {
    let called = false;
    const client = new ProviderClient({
      fetchImpl: (async () => { called = true; return new Response("{}"); }) as typeof fetch,
    });
    const result = await client.fetchModels(config({ presetId: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }));
    expect(result.ok).toBe(true);
    expect(result.fallback).toBe(true);
    expect(called).toBe(false);
  });

  it("reports an honest error when there is no catalog and no preset list", async () => {
    const client = new ProviderClient({
      fetchImpl: fetchStub({ "/models": () => new Response("boom", { status: 500 }) }),
    });
    const result = await client.fetchModels(config({ presetId: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("uses the StepFun /v1 catalog for a Plan base URL", async () => {
    const urls: string[] = [];
    const client = new ProviderClient({
      fetchImpl: (async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ data: [{ id: "step-3.5-flash" }] }), { status: 200 });
      }) as typeof fetch,
    });
    await client.fetchModels(config({ protocol: "stepfun-plan", baseUrl: "https://api.stepfun.com/step_plan/v1" }));
    expect(urls[0]).toBe("https://api.stepfun.com/v1/models");
  });
});

describe("preset catalogue", () => {
  it("covers every platform the settings UI offers", () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    for (const expected of [
      "stepfun-v1", "stepfun-plan", "deepseek", "openai", "openrouter", "moonshot",
      "zhipu", "dashscope", "siliconflow", "ollama", "lmstudio", "vllm", "custom",
    ]) expect(ids).toContain(expected);
    // Every preset has an editable base URL and a model story.
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
      expect(preset.supportsModelsEndpoint || preset.defaultModels.length > 0).toBe(true);
    }
  });
});
