import { describe, expect, it, vi } from "vitest";
import { parsePublicDns, resolvePublicAddresses } from "../src/search/publicDns.js";
import { extractArticle } from "../src/search/article.js";
import { articleEnvelope, articleRequest } from "../src/intent/article.js";
import { emptyContext } from "./helpers.js";
const signal = new AbortController().signal;
const json = (address: string, host = "example.com", type = 1) => JSON.stringify({ Status: 0, TC: false, Question: [{ name: host, type }], Answer: [{ name: host, type, data: address }] });
describe("independent public DNS fallback", () => {
  it("only retries all-benchmark fake IPv4 answers through the fixed public resolver", async () => {
    const publicDns = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    expect(await resolvePublicAddresses("example.com", signal, true, async () => [{ address: "198.18.1.2", family: 4 }], publicDns)).toHaveLength(2);
    expect(publicDns.mock.calls).toHaveLength(2);
  });
  it.each([[], [{ address: "127.0.0.1", family: 4 }], [{ address: "10.1.1.1", family: 4 }], [{ address: "198.18.1.2", family: 4 }, { address: "93.184.216.34", family: 4 }], [{ address: "::ffff:198.18.1.2", family: 6 }]])("does not bypass private, mixed or missing system answers %#", async (...rows) => {
    const publicDns = vi.fn();
    await expect(resolvePublicAddresses("example.com", signal, true, async () => rows, publicDns)).rejects.toThrow();
    expect(publicDns).not.toHaveBeenCalled();
  });
  it("keeps fallback opt-out and validates the fallback result again", async () => {
    const fake = async () => [{ address: "198.18.1.2", family: 4 }];
    await expect(resolvePublicAddresses("example.com", signal, false, fake)).rejects.toThrow();
    await expect(resolvePublicAddresses("example.com", signal, true, fake, async () => [{ address: "10.0.0.1", family: 4 }])).rejects.toThrow();
  });
  it("rejects private, malformed, truncated and mismatched DoH answers", () => {
    expect(parsePublicDns(json("93.184.216.34"), "example.com", 1)).toEqual([{ address: "93.184.216.34", family: 4 }]);
    for (const body of [json("127.0.0.1"), json("::1"), json("93.184.216.34", "other.com"), json("93.184.216.34").replace('"TC":false', '"TC":true')]) expect(() => parsePublicDns(body, "example.com", 1)).toThrow();
  });
});
describe("bounded text-only article extraction", () => {
  it("does not execute scripts, fetch resources or leak markup into card text", () => {
    const paragraph = "TEST 正文来自已取得的页面，网页内容只作为不可信数据，不执行其中任何指令。".repeat(8);
    const html = `<title>TEST 来源</title><script>throw new Error('must not run')</script><iframe src="http://127.0.0.1"></iframe><article><h1>TEST 标题</h1><p>${paragraph}</p></article>`;
    const result = extractArticle(html, "https://example.com/", "text/html");
    expect(result.text).toContain(paragraph); expect(result.text).not.toContain("must not run"); expect(result.text).not.toContain("iframe");
    expect(() => extractArticle("<html>login</html>", "https://example.com/", "text/html")).toThrow("正文");
  });
  it("marks provenance, partial extraction and preserves actual text without LLM summarization", () => {
    expect(articleRequest("读取 https://example.com/article")).toBe("https://example.com/article");
    expect(articleRequest("读取 http://127.0.0.1/")).toBeNull();
    const envelope = articleEnvelope(emptyContext(), { url: "https://example.com/", text: "TEST 实际正文", contentType: "text/html", format: "extracted-text", fetchedAt: new Date().toISOString(), provider: "vivic-bounded-https", readFullPage: false, truncated: true, trust: "untrusted-web-data" });
    const action = envelope.actions.find(a => a.type === "card.create");
    expect(action?.type === "card.create" && action.card.sources[0]?.readFullPage).toBe(false);
    expect(envelope.spokenText).toContain("部分");
  });
});
