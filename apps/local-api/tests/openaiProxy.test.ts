import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  OpenAIEgressDispatcher,
  isOpenAIHost,
  parseWindowsProxyServer,
  redactProxy,
  resolveOpenAIProxy,
} from "../src/openaiProxy.js";

describe("OpenAI egress proxy resolution", () => {
  it("only OpenAI/ChatGPT hosts are proxied", () => {
    for (const host of ["auth.openai.com", "api.openai.com", "openai.com", "chatgpt.com", "chatgpt.com."]) {
      expect(isOpenAIHost(host)).toBe(true);
    }
    for (const host of ["api.stepfun.com", "notopenai.com", "openai.com.evil.test", "127.0.0.1", "localhost"]) {
      expect(isOpenAIHost(host)).toBe(false);
    }
  });

  it("parses both Windows ProxyServer formats", () => {
    expect(parseWindowsProxyServer("127.0.0.1:7892")).toBe("http://127.0.0.1:7892/");
    expect(parseWindowsProxyServer("http=127.0.0.1:1;https=127.0.0.1:2;socks=127.0.0.1:3")).toBe("http://127.0.0.1:2/");
    expect(parseWindowsProxyServer("http=127.0.0.1:1")).toBe("http://127.0.0.1:1/");
    expect(parseWindowsProxyServer("socks=127.0.0.1:3")).toBeUndefined();
  });

  it("explicit > env > system, and `direct` opts out", () => {
    const system = () => "http://127.0.0.1:7892/";
    expect(resolveOpenAIProxy({}, system)).toEqual({ url: "http://127.0.0.1:7892/", source: "system" });
    expect(resolveOpenAIProxy({ HTTPS_PROXY: "http://10.0.0.1:8080" }, system)).toEqual({ url: "http://10.0.0.1:8080/", source: "env" });
    expect(resolveOpenAIProxy({ VIVIC_OPENAI_PROXY: "127.0.0.1:9000", HTTPS_PROXY: "http://10.0.0.1:8080" }, system))
      .toEqual({ url: "http://127.0.0.1:9000/", source: "VIVIC_OPENAI_PROXY" });
    expect(resolveOpenAIProxy({ VIVIC_OPENAI_PROXY: "direct", HTTPS_PROXY: "http://10.0.0.1:8080" }, system)).toBeUndefined();
    expect(resolveOpenAIProxy({}, () => undefined)).toBeUndefined();
  });

  it("never logs proxy credentials", () => {
    expect(redactProxy("http://user:secret@127.0.0.1:7892/")).toBe("http://127.0.0.1:7892");
  });

  it("re-reads the proxy after its TTL", () => {
    let current: string | undefined;
    const dispatcher = new OpenAIEgressDispatcher({
      resolve: () => (current ? { url: current, source: "system" } : undefined), ttlMs: 0,
    });
    expect(dispatcher.current()).toBeUndefined();
    current = "http://127.0.0.1:7892/";
    expect(dispatcher.current()?.url).toBe(current);
    void dispatcher.close();
  });
});

describe("OpenAI egress dispatcher (offline fake proxy)", () => {
  let proxy: Server | undefined;
  let dispatcher: OpenAIEgressDispatcher | undefined;
  afterEach(async () => {
    await dispatcher?.destroy();
    await new Promise<void>(resolve => (proxy ? proxy.close(() => resolve()) : resolve()));
    proxy = dispatcher = undefined;
  });

  it("tunnels OpenAI through the proxy and leaves other hosts direct", async () => {
    const connects: string[] = [];
    proxy = createServer();
    proxy.on("connect", (request, socket) => {
      connects.push(request.url ?? "");
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    await new Promise<void>(resolve => proxy!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    dispatcher = new OpenAIEgressDispatcher({ resolve: () => ({ url, source: "VIVIC_OPENAI_PROXY" }) });

    // The fake proxy refuses the tunnel, so the request fails — after going through it.
    await expect(fetch("https://auth.openai.com/api/accounts/oauth/token", {
      method: "POST", body: "x", dispatcher, signal: AbortSignal.timeout(5000),
    } as RequestInit)).rejects.toThrow();
    expect(connects).toEqual(["auth.openai.com:443"]);

    // A non-OpenAI host never touches the proxy.
    const direct = createServer((_, response) => response.end("direct"));
    await new Promise<void>(resolve => direct.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(direct.address() as AddressInfo).port}/`, { dispatcher } as RequestInit);
      expect(await response.text()).toBe("direct");
    } finally {
      await new Promise<void>(resolve => direct.close(() => resolve()));
    }
    expect(connects).toEqual(["auth.openai.com:443"]);
  });
});
