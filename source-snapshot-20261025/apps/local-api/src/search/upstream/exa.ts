/**
 * Code-level safe subset of pi-web-access 0.41.0 exa.ts, MIT (c) 2025 Nico Bailon.
 * Source commit d47dc040552505e3b135d0136a0b15eaf4bdba52; see PROVENANCE.md.
 * Retains the upstream tools/call request, SSE/JSON decoding and text-block parser.
 * Changes: fixed basic tool; bounded pinned HTTPS transport; safe errors; explicit
 * HTTP-200 quota detection; optional proxy egress for this fixed endpoint. No config,
 * credential resolution, Pi runtime or provider fallback.
 */
import { SearchError } from "../errors.js";
import { abortError, requestPublicHttps, requestViaProxy, type HttpsReply } from "../transport.js";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa";
const EXA_MCP_BASIC_TOOL = "web_search_exa";
type McpParsedResult = { title: string; url: string; content: string };
interface ExaMcpRpcResponse {
  id?: number;
  jsonrpc?: string;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
  };
  error?: { code?: number; message?: string };
}
const invalidResponse = () => new SearchError("search-invalid-response", "搜索源未返回有效的来源列表。", 502);
const rateLimited = () => new SearchError("search-rate-limited", "搜索源免费额度暂时受限，请稍后重试。", 429);

// A desktop proxy may stall its first tunnel; leave the rest for a direct try.
const PROXY_ATTEMPT_MS = 15_000;

export async function callExaMcp(query: string, numResults: number, signal: AbortSignal, maxBytes: number, publicDnsFallback = false, proxyUrl?: string): Promise<string> {
  const toolName = EXA_MCP_BASIC_TOOL;
  const args = { query, numResults };
  const request = {
    method: "POST" as const,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "x-exa-source": "pi-web-access",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
    maxBytes,
    acceptContentType: (type: string) => type === "application/json" || type === "text/event-stream",
  };
  let response: HttpsReply | undefined;
  // Vivic: the fixed endpoint may only be reachable through the user's proxy
  // (corporate network, desktop proxy app). Any transport failure there falls
  // back to the pinned direct connection below.
  if (proxyUrl) {
    try { response = await requestViaProxy(EXA_MCP_URL, proxyUrl, { ...request, signal: AbortSignal.any([signal, AbortSignal.timeout(PROXY_ATTEMPT_MS)]) }); }
    catch { if (signal.aborted) throw abortError(signal); }
  }
  if (!response) try { response = await requestPublicHttps(EXA_MCP_URL, { ...request, signal, publicDnsFallback }); } catch (error) {
    // A fixed provider endpoint failing DNS policy is service unavailability,
    // rather than a bad search query. Keep user-selected fetch URL errors as 400.
    if (error instanceof SearchError && error.code === "search-blocked-url") {
      throw new SearchError("search-unavailable", "当前搜索源 DNS 未通过公网地址校验。", 503);
    }
    throw error;
  }
  if (response.status === 429) throw rateLimited();
  if (response.status < 200 || response.status >= 300) {
    throw new SearchError("search-unavailable", "当前搜索源不可用，请稍后重试。", 502);
  }
  const body = response.body.toString("utf8");
	const dataLines = body.split("\n").filter(line => line.startsWith("data:"));

	let parsed: ExaMcpRpcResponse | null = null;
	for (const line of dataLines) {
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const candidate = JSON.parse(payload) as ExaMcpRpcResponse;
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
				break;
			}
		} catch {
		}
	}

	if (!parsed) {
		try {
			const candidate = JSON.parse(body) as ExaMcpRpcResponse;
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
			}
		} catch {
		}
	}

	if (!parsed) {
		throw invalidResponse();
	}

	// Vivic hardening: Exa can rate-limit in HTTP 200 without isError.
	if (parsed.result?._meta?.["ai.exa/rateLimited"] === true) throw rateLimited();
	if (parsed.error || parsed.result?.isError) throw invalidResponse();
	if (parsed.id !== 1 || parsed.jsonrpc !== "2.0" || !Array.isArray(parsed.result?.content)) throw invalidResponse();

	const text = parsed.result?.content
		?.find(item => item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0)
		?.text;

	if (!text) {
		throw invalidResponse();
	}

	return text;
}

export function parseMcpResults(text: string): McpParsedResult[] | null {
	const blocks = text.split(/(?=^Title: )/m).filter(block => block.trim().length > 0);
	const parsed = blocks.map(block => {
		const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
		const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
		let content = "";
		const textStart = block.indexOf("\nText: ");
		if (textStart >= 0) {
			content = block.slice(textStart + 7).trim();
		} else {
			const hlMatch = block.match(/\nHighlights:\s*\n/);
			if (hlMatch?.index != null) {
				content = block.slice(hlMatch.index + hlMatch[0].length).trim();
			}
		}
		content = content.replace(/\n---\s*$/, "").trim();
		return { title, url, content };
	}).filter(result => result.url.length > 0);
	return parsed.length > 0 ? parsed : null;
}
