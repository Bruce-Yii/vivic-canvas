import { spawn } from "node:child_process";
import { existsSync, statSync, accessSync, constants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ConnectionError, type ConnectionConfig, type ReadTool } from "./types.js";

const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const textField = (description: string) => ({ type: "string", minLength: 1, maxLength: 1000, description });
export const CLI_TOOLS: Record<"feishu" | "wecom" | "dingtalk", ReadTool[]> = {
  feishu: [
    { name: "search-doc", title: "搜索文档", description: "按关键词搜索当前用户可访问的飞书文档。", inputSchema: objectSchema({ query: textField("搜索关键词") }, ["query"]) },
    { name: "fetch-doc", title: "阅读文档", description: "阅读飞书 docx 或 Wiki 文档。", inputSchema: objectSchema({ doc: textField("飞书文档链接") }, ["doc"]) },
  ],
  wecom: [
    { name: "search-doc", title: "搜索文档", description: "按关键词搜索当前用户可访问的企业微信文档。", inputSchema: objectSchema({ query: textField("搜索关键词") }, ["query"]) },
    { name: "fetch-doc", title: "阅读文档", description: "阅读企业微信在线 doc 文档，暂不支持表格及智能文档。", inputSchema: objectSchema({ doc: textField("企业微信 doc 文档链接") }, ["doc"]) },
  ],
  dingtalk: [
    { name: "search-doc", title: "搜索文档", description: "搜索已授权的钉钉文档。", inputSchema: objectSchema({ query: textField("搜索关键词") }, ["query"]) },
    { name: "fetch-doc", title: "阅读文档", description: "读取已授权的钉钉文档。", inputSchema: objectSchema({ doc: textField("钉钉文档编号或链接") }, ["doc"]) },
  ],
};

/** Only native CLI binaries are launched, never shell wrappers or model-generated commands. */
export function findCli(provider: "feishu" | "wecom" | "dingtalk"): string | undefined {
  const name = provider === "feishu" ? "lark-cli" : provider === "wecom" ? "wecom-cli" : "dws";
  const override = process.env[provider === "feishu" ? "VIVIC_LARK_CLI_PATH" : provider === "wecom" ? "VIVIC_WECOM_CLI_PATH" : "VIVIC_DINGTALK_CLI_PATH"];
  const candidates: string[] = override && path.isAbsolute(override) ? [override] : [];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const ext = process.platform === "win32" ? ".exe" : "";
    candidates.push(path.join(directory, name + ext));
    if (provider === "feishu") candidates.push(path.join(directory, "node_modules/@larksuite/cli/bin", name + ext));
    else candidates.push(path.join(directory, `node_modules/@wecom/cli/node_modules/@wecom/cli-${process.platform}-${process.arch}/bin`, name + ext),
      path.join(directory, `node_modules/@wecom/cli-${process.platform}-${process.arch}/bin`, name + ext));
  }
  return candidates.find(candidate => {
    if (/\.(cmd|bat|ps1|js|mjs|cjs)$/i.test(candidate) || !existsSync(candidate)) return false;
    try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); } catch { return false; }
  });
}

export function cliArguments(provider: "feishu" | "wecom" | "dingtalk", name: string, args: Record<string, unknown>): string[] {
  if (provider === "dingtalk") {
    if (name === "test") return ["auth", "status", "--readonly", "--format", "json"];
    if (name === "search-doc") return ["doc", "search", "--query", String(args.query), "--format", "json"];
    if (name === "fetch-doc") return ["doc", "read", "--node", String(args.doc), "--format", "json"];
    throw new ConnectionError("tool-not-allowed", "此操作未开放。", 403);
  }
  if (name === "test") return provider === "feishu" ? ["api", "GET", "/open-apis/authen/v1/user_info", "--as", "user", "--format", "json"] : ["identity", "whoami"];
  if (name === "search-doc") {
    const query = String(args.query);
    if (provider === "feishu") return ["drive", "+search", "--query", query, "--as", "user", "--format", "json"];
    const tokens = [...new Intl.Segmenter("zh-CN", { granularity: "word" }).segment(query)].filter(part => part.isWordLike).map(part => part.segment).filter(word => !["帮我", "找", "找下", "的", "文档"].includes(word));
    const keywords = [...new Set([tokens.join(" "), ...tokens])].filter(Boolean).slice(0, 12);
    if (!keywords.length) throw new ConnectionError("query-required", "请输入具体的搜索关键词。");
    return ["doc", "search", "--json", JSON.stringify({ keywords, search_scope: "title_content", limit: 10 })];
  }
  if (name === "fetch-doc") {
    let url: URL;
    try { url = new URL(String(args.doc)); } catch { throw new ConnectionError("invalid-document", "请使用完整的文档链接。"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new ConnectionError("invalid-document", "文档链接格式不正确。");
    if (provider === "feishu" && /(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname) && /^\/(docx|wiki)\/[A-Za-z0-9]+/.test(url.pathname)) {
      return ["docs", "+fetch", "--doc", url.href, "--as", "user", "--format", "json"];
    }
    if (provider === "wecom" && url.hostname === "doc.weixin.qq.com" && /^\/doc\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
      return ["doc", "contents", "get", "--json", JSON.stringify({ docid: url.pathname.split("/").at(-1), content_type: "markdown" })];
    }
    throw new ConnectionError("unsupported-document", "此链接类型暂不支持阅读，请使用平台在线文档链接。");
  }
  throw new ConnectionError("tool-not-allowed", "此操作未开放。", 403);
}

export type CliRunner = (config: ConnectionConfig, name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
export function isolatedCliEnvironment(config: ConnectionConfig, root: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: inherited.PATH, SystemRoot: inherited.SystemRoot, WINDIR: inherited.WINDIR,
    TMP: root, TEMP: root, TMPDIR: root, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, XDG_CONFIG_HOME: root,
    LARKSUITE_CLI_CONFIG_DIR: root, WECOM_CLI_CONFIG_DIR: root, NO_COLOR: "1" };
  if (config.provider === "feishu") {
    env.LARKSUITE_CLI_APP_ID = config.appId; env.LARKSUITE_CLI_USER_ACCESS_TOKEN = config.token; env.LARKSUITE_CLI_BRAND = "feishu";
    env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = "1"; env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = "1";
  } else env.WECOM_CLI_ACCESS_TOKEN = config.token;
  return env;
}
export const runCli: CliRunner = async (config, name, args, signal) => {
  if (config.provider !== "feishu" && config.provider !== "wecom") throw new ConnectionError("cli-unavailable", "此平台不支持 CLI 连接。");
  const binary = findCli(config.provider);
  if (!binary) throw new ConnectionError("cli-not-installed", `服务主机尚未安装 ${config.provider === "feishu" ? "Lark CLI" : "WeCom CLI"}，请安装后重新测试。`, 503);
  const argv = cliArguments(config.provider, name, args);
  const root = await mkdtemp(path.join(tmpdir(), "vivic-connection-"));
  try {
    // Do not inherit credentials, proxy headers, keychains, shell startup files or HOME.
    const env = isolatedCliEnvironment(config, root);
    const output = await new Promise<string>((resolve, reject) => {
      if (signal.aborted) return reject(new ConnectionError("request-ended", "查询已取消。", 409));
      const child = spawn(binary, argv, { cwd: root, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let bytes = 0, stdout = "", settled = false;
      const decoder = new StringDecoder("utf8");
      const finish = (error?: Error) => { if (settled) return; settled = true; signal.removeEventListener("abort", abort); if (error) { child.kill(); reject(error); } else resolve(stdout + decoder.end()); };
      const abort = () => finish(new ConnectionError("request-ended", "查询超时或已取消。", 409));
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256 * 1024) finish(new ConnectionError("response-too-large", "内容过多，请缩小查询范围。", 413)); else stdout += decoder.write(chunk); });
      child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256 * 1024) finish(new ConnectionError("response-too-large", "内容过多，请缩小查询范围。", 413)); });
      child.on("error", () => finish(new ConnectionError("cli-unavailable", "无法启动连接工具，请检查服务主机安装。", 503)));
      child.on("close", code => finish(code === 0 ? undefined : new ConnectionError("cli-query-failed", "查询失败，请检查令牌、应用配置和授权范围。", 502)));
    });
    let result: unknown;
    try { result = JSON.parse(output); } catch { throw new ConnectionError("invalid-cli-response", "连接工具返回了无法读取的内容。", 502); }
    const r = result as { ok?: boolean; error?: unknown; errcode?: number; code?: number };
    if (!r || r.ok === false || r.error || r.errcode && r.errcode !== 0 || r.code && r.code !== 0) throw new ConnectionError("cli-query-failed", "查询失败，请检查令牌和授权范围。", 502);
    return result;
  } finally {
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith("vivic-connection-")) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
};
