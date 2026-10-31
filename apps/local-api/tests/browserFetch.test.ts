import { describe, expect, it } from "vitest";
import { createBrowserFetch } from "../src/browserFetch.js";
describe("packaged same-origin browser API bridge", () => {
  const handler = createBrowserFetch(request => new Response(request.headers.has("authorization") ? "authorized" : "denied"), 18787, "private-test-token");
  it("injects only for exact local browser origins", async () => {
    const request = new Request("http://127.0.0.1:18787/api/mobile/status", { headers: { "sec-fetch-site": "same-origin" } });
    expect(await (await handler(request)).text()).toBe("authorized");
    expect(request.headers.has("authorization")).toBe(false);
  });
  it.each([
    ["http://attacker.example:18787/api/intent", "same-origin", ""],
    ["http://127.0.0.1:18787/api/intent", "cross-site", "http://attacker.example"],
    ["http://127.0.0.1:18787/api/intent", "same-site", "http://127.0.0.1:9999"],
    ["http://127.0.0.1:18787/api/intent", "same-origin", "http://attacker.example"],
    ["http://127.0.0.1:18787/api/intent", "", ""],
  ])("does not authenticate an untrusted fetch", async (url, site, origin) => {
    expect(await (await handler(new Request(url, { headers: { "sec-fetch-site": site, origin } }))).text()).toBe("denied");
  });
});
