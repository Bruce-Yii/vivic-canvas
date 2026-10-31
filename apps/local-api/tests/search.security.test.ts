import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ClientRequest } from "node:http";
import { request, type RequestOptions } from "node:https";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { publicHttpsUrl, isPublicAddress } from "../src/search/policy.js";
import { requestPublicHttps } from "../src/search/transport.js";
import { createSearchClient } from "../src/search/client.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
const dns = vi.mocked(lookup as (host: string, options?: { all: true; verbatim: true }) => Promise<LookupAddress[]>);
const https = vi.mocked(request);
let optionsSeen: RequestOptions;
let urlSeen: URL;
let responseSeen: PassThrough;
let requestDestroyed: boolean;

function respond(settings: {
  status?: number;
  headers?: Record<string, string | undefined>;
  chunks?: Buffer[];
  stall?: boolean;
  abortOnDestroy?: boolean;
} = {}) {
  https.mockImplementation(((url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    urlSeen = url; optionsSeen = options;
    const req = new EventEmitter() as ClientRequest;
    req.destroy = (() => { requestDestroyed = true; responseSeen?.destroy(); return req; }) as ClientRequest["destroy"];
    req.end = (() => {
      queueMicrotask(() => {
        const response = new PassThrough();
        if (settings.abortOnDestroy) {
          const destroy = response.destroy.bind(response);
          response.destroy = ((error?: Error) => { response.emit("aborted"); return destroy(error); }) as typeof response.destroy;
        }
        responseSeen = response;
        Object.assign(response, { statusCode: settings.status ?? 200,
          headers: { "content-type": "text/plain; charset=utf-8", ...settings.headers } });
        callback(response as unknown as IncomingMessage);
        if (!settings.stall) {
          for (const chunk of settings.chunks ?? [Buffer.from("Public document")]) response.write(chunk);
          response.end();
        }
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  }) as typeof request);
}
const get = (url = "https://example.com", signal = AbortSignal.timeout(1000), maxBytes = 100) =>
  requestPublicHttps(url, { signal, maxBytes, acceptContentType: type => type === "text/plain" });

beforeEach(() => {
  dns.mockReset(); https.mockReset(); requestDestroyed = false;
  dns.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
  respond();
});

describe("public-only URL and address policy", () => {
  it.each([
    "0.0.0.0", "10.1.1.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.9", "192.0.2.1", "192.88.99.1", "192.168.0.1", "198.18.0.187", "198.19.255.255",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1",
    "::ffff:8.8.8.8", "64:ff9b::a00:1", "fc00::1", "fd00::1", "fe80::1", "ff02::1",
    "2001::1", "2001:20::1", "2001:db8::1", "2002:a00:1::", "3fff::1", "not-an-ip",
  ])("blocks private, reserved and transition address %s", address => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "93.184.215.14", "2606:4700:4700::1111", "2001:4860:4860::8888"]) (
    "accepts globally routable address %s", address => expect(isPublicAddress(address)).toBe(true),
  );
  it.each([
    "https://2130706433", "https://0x7f000001", "https://0177.0.0.1", "https://127.1", "https://[::ffff:7f00:1]",
    "https://localhost.", "https://sub.localhost", "https://printer.local", "https://service.internal",
    "https://host.lan", "https://host.home", "https://metadata.google.internal", "https://a.onion",
    "https://user:password@example.com", "https://example.com:444", "http://example.com", "file:///tmp/file",
    "data:text/plain,hello", "gopher://example.com", "https://example.com\\@127.0.0.1", "https://example.com\n",
  ])("rejects unsafe URL before DNS or networking: %s", async url => {
    await expect(get(url)).rejects.toMatchObject({ code: "search-blocked-url" });
    expect(dns).not.toHaveBeenCalled();
    expect(https).not.toHaveBeenCalled();
  });
  it("normalizes trailing-dot public names and removes fragments", () => {
    expect(publicHttpsUrl("https://EXAMPLE.com.:443/page#fragment").href).toBe("https://example.com/page");
  });
});

describe("actual HTTPS request boundary (wire primitives stubbed, policy real)", () => {
  it("retains the byte-limit explanation when socket teardown synchronously emits aborted", async () => {
    respond({ chunks: [Buffer.alloc(80), Buffer.alloc(80)], abortOnDestroy: true });
    await expect(get()).rejects.toMatchObject({ code: "search-too-large", message: "网页响应超过大小限制。" });
    expect(responseSeen.destroyed).toBe(true);
  });
  it.each([
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "198.18.0.187", family: 4 }],
    [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.1", family: 4 }],
    [{ address: "93.184.215.14", family: 4 }, { address: "::1", family: 6 }],
    [{ address: "93.184.215.14", family: 6 }], [],
  ].map(addresses => ({ addresses })))("refuses every private/mixed/invalid DNS answer before creating a socket: $addresses", async ({ addresses }) => {
    dns.mockResolvedValue(addresses);
    await expect(get()).rejects.toMatchObject({ code: "search-blocked-url" });
    expect(https).not.toHaveBeenCalled();
  });

  it("pins the validated address without a second DNS lookup, retaining HTTPS host/TLS identity", async () => {
    const res = await get();
    expect(res.body.toString()).toBe("Public document");
    expect(dns).toHaveBeenCalledTimes(1);
    expect(urlSeen.href).toBe("https://example.com/");
    expect(optionsSeen.family).toBe(4);
    expect(optionsSeen.agent).toBe(false);
    const callback = vi.fn();
    optionsSeen.lookup!("example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.215.14", 4);
    expect(dns).toHaveBeenCalledTimes(1);
    expect(optionsSeen).not.toHaveProperty("rejectUnauthorized", false);
    expect(optionsSeen.headers).not.toHaveProperty("Authorization");
    expect(optionsSeen.headers).not.toHaveProperty("Cookie");
    expect(optionsSeen.headers).toHaveProperty("Accept-Encoding", "identity");
  });

  it("validates a public IPv6 literal without DNS and pins that family", async () => {
    await get("https://[2606:4700:4700::1111]/");
    expect(dns).not.toHaveBeenCalled();
    expect(optionsSeen.family).toBe(6);
  });

  it.each(["https://other.example.com", "/again"]) (
    "revalidates DNS on every redirect, including same-host rebinding: %s", async location => {
      respond({ status: 302, headers: { location } });
      dns.mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }])
        .mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
      await expect(createSearchClient().fetchContent("https://example.com")).rejects.toMatchObject({ code: "search-blocked-url" });
      expect(dns).toHaveBeenCalledTimes(2);
      expect(https).toHaveBeenCalledTimes(1);
      expect(responseSeen.destroyed).toBe(true);
    },
  );

  it("bounds DNS latency and never opens a socket after a late lookup", async () => {
    let finish!: (value: LookupAddress[]) => void;
    dns.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = get("https://example.com", AbortSignal.timeout(15));
    await expect(pending).rejects.toMatchObject({ code: "search-timeout" });
    finish([{ address: "93.184.215.14", family: 4 }]);
    await Promise.resolve();
    expect(https).not.toHaveBeenCalled();
  });

  it("refuses caller cancellation before DNS", async () => {
    await expect(get("https://example.com", AbortSignal.abort())).rejects.toMatchObject({ code: "search-cancelled" });
    expect(dns).not.toHaveBeenCalled();
    expect(https).not.toHaveBeenCalled();
  });

  it("enforces declared and streamed byte limits, destroys oversized responses", async () => {
    respond({ headers: { "content-length": "101" }, stall: true });
    await expect(get()).rejects.toMatchObject({ code: "search-too-large" });
    expect(requestDestroyed).toBe(true);
    respond({ chunks: [Buffer.alloc(60), Buffer.alloc(41)] });
    requestDestroyed = false;
    await expect(get()).rejects.toMatchObject({ code: "search-too-large" });
    expect(requestDestroyed).toBe(true);
    expect(responseSeen.destroyed).toBe(true);
  });

  it("accepts the exact byte limit, counts UTF-8 bytes rather than characters", async () => {
    respond({ chunks: [Buffer.from("中".repeat(10))] });
    await expect(get("https://example.com", undefined, 29)).rejects.toMatchObject({ code: "search-too-large" });
    respond({ chunks: [Buffer.alloc(100)] });
    expect((await get()).body.byteLength).toBe(100);
  });

  it.each([
    { "content-type": "application/octet-stream" },
    { "content-type": "application/pdf" },
    { "content-encoding": "gzip" },
    { "content-encoding": "br" },
  ])("rejects binary or compressed payloads before buffering", async headers => {
    respond({ headers, stall: true });
    await expect(get()).rejects.toMatchObject({ code: "search-unsupported-content" });
    expect(requestDestroyed).toBe(true);
  });

  it("destroys redirect/error bodies immediately and never auto-follows", async () => {
    respond({ status: 302, headers: { location: "https://127.0.0.1/" }, stall: true });
    const res = await get();
    expect(res.status).toBe(302);
    expect(res.body.byteLength).toBe(0);
    expect(responseSeen.destroyed).toBe(true);
    expect(https).toHaveBeenCalledTimes(1);
  });
});
