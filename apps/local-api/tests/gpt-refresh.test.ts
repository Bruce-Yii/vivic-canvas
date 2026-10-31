import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { GptProvider, GPT_REFRESH_TIMEOUT_MS } from "../src/gpt/provider.js";
import { GPT_MODELS, GPT_RESPONSES } from "../src/gpt/transport.js";

// Pi refreshes through the global fetch, so this file stubs it with TEST
// replies for the token endpoint only. No user auth, login or network.
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const MODEL = "gpt-test-refresh";
const sse = (value: unknown) => {
  const text = JSON.stringify(value);
  const item = { id: "msg_TEST", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const frame = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  return new Response([
    frame({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text }),
    frame({ type: "response.output_item.done", output_index: 0, item }),
    frame({ type: "response.completed", response: { id: "resp_TEST", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
};

const expiring = async () => {
  const piStorage = new InMemoryCredentialStore();
  await piStorage.modify("openai", async () => ({ type: "oauth", access: "TEST-old-access", refresh: "TEST-old-refresh",
    expires: Date.now() + 60_000, clientId: "TEST-client", scopes: ["chatgpt.tokens.use.direct"] }));
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url === GPT_MODELS) return Response.json({ models: [{ slug: MODEL, visibility: "list" }] });
    if (url === GPT_RESPONSES) return sse({ ok: true });
    throw new Error(`TEST forbids endpoint: ${url}`);
  });
  return { piStorage, gpt: new GptProvider({ piStorage, ownStorage: new InMemoryCredentialStore(), fetchImpl }) };
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("GPT token refresh through a slow proxy", () => {
  it("bounds the refresh by Vivic's longer deadline, not Pi's fixed 15 s", async () => {
    const timeouts = new Map<number, AbortSignal>();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const signal = timeout(ms); timeouts.set(ms, signal); return signal; });
    let tokenSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== TOKEN_URL) throw new Error("TEST forbids ambient network");
      tokenSignal = init?.signal ?? undefined;
      return Response.json({ access_token: "TEST-new-access", refresh_token: "TEST-new-refresh", scope: "openid chatgpt.tokens.use.direct", expires_in: 3600 });
    }));
    const f = await expiring();
    expect(await f.gpt.connect("pi", MODEL)).toBe(true);
    expect(tokenSignal).toBe(timeouts.get(GPT_REFRESH_TIMEOUT_MS));
    expect(await f.piStorage.read("openai")).toMatchObject({ access: "TEST-new-access", refresh: "TEST-new-refresh" });
    await f.gpt.disconnect();
  });

  it("a refresh timeout says the saved login is still valid instead of asking to log in again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("TEST slow tunnel", "TimeoutError"); }));
    const f = await expiring();
    expect(await f.gpt.connect("pi", MODEL)).toBe(false);
    const error = f.gpt.status().lastError ?? "";
    expect(error).toContain("超时");
    expect(error).toContain("无需重新登录");
    expect(error).not.toContain("TEST");
    expect(await f.piStorage.read("openai")).toMatchObject({ refresh: "TEST-old-refresh" });
  });
});
