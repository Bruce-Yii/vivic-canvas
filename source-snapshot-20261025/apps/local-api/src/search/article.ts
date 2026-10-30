import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { SearchError } from "./errors.js";

/** Default jsdom executes no scripts and loads no subresources. Never enable
 * runScripts/resources or return HTML to a card renderer. */
export function extractArticle(raw: string, url: string, contentType: string): { text: string; title: string } {
  const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!/html/.test(contentType)) return { text: clean(raw), title: new URL(url).hostname };
  const dom = new JSDOM(raw, { url, virtualConsole: new VirtualConsole() });
  try {
    const document = dom.window.document;
    for (const node of document.querySelectorAll("script,style,noscript,iframe,object,embed,template,svg,canvas,form")) node.remove();
    if (document.getElementsByTagName("*").length > 20000) throw new SearchError("search-too-large", "网页结构超过解析限制。", 413);
    const fallback = document.body.textContent ?? "", title = clean(document.title).slice(0, 300);
    const article = new Readability(document, { charThreshold: 0, maxElemsToParse: 20000 }).parse();
    const text = clean(article?.textContent ?? fallback);
    if (text.length < 40) throw new SearchError("search-unsupported-content", "没有取得足够的网页正文；该页可能需要登录或脚本渲染。", 415);
    return { text, title: clean(article?.title ?? title).slice(0, 300) || new URL(url).hostname };
  } finally { dom.window.close(); }
}
