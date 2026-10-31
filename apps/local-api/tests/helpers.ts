import type { LocalApiConfig } from "../src/config.js";
import type { CanvasContext } from "../src/schemas.js";

export const TEST_TOKEN = "test-token-0123456789";

export const testConfig = (
  overrides: Partial<LocalApiConfig> = {},
): LocalApiConfig => ({
  port: 0,
  host: "127.0.0.1",
  token: TEST_TOKEN,
  tokenPath: "/dev/null",
  tokenGenerated: false,
  allowedOrigins: ["http://localhost:5173"],
  stepfunBaseUrl: "https://unit.test/v1",
  requestTimeoutMs: 60,
  bodyLimitBytes: 64 * 1024,
  ...overrides,
});

export const authed = {
  authorization: `Bearer ${TEST_TOKEN}`,
  "content-type": "application/json",
};

export const emptyContext = (cards: CanvasContext["cards"] = []): CanvasContext => ({
  canvasId: "c1",
  stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: [],
  cards,
});

/** Fetch stub: routes by URL suffix. */
export const fetchStub = (
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
  onCall?: (url: string) => void,
): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    onCall?.(url);
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    return new Response("not stubbed", { status: 500 });
  }) as typeof fetch;

export const modelsOk = (ids: string[] = ["step-3", "step-1-8k"]) =>
  new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

export const chatOk = (payload: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
