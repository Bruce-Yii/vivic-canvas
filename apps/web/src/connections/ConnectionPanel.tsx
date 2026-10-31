import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { connectionRequest, connectionsChanged, type ConnectionProvider, type ConnectionStatus } from "./api";
import "./connections.css";

const SERVICES: Array<{ provider: ConnectionProvider; label: string; help: string; href: string }> = [
  { provider: "feishu", label: "飞书", help: "使用本人的用户访问令牌（UAT），查询已授权的文档与资料。", href: "https://open.feishu.cn/document/mcp_open_tools/developers-call-remote-mcp-server" },
  { provider: "mcdonalds", label: "麦当劳", help: "在麦当劳 MCP 控制台获取个人 Token，查看活动、优惠与餐品。", href: "https://open.mcd.cn/mcp" },
  { provider: "wecom", label: "企业微信", help: "使用本人的 WeCom CLI 访问令牌。服务主机需要安装官方 CLI。", href: "https://github.com/WecomTeam/wecom-cli" },
  { provider: "dingtalk", label: "钉钉", help: "粘贴从钉钉获取的个人 Streamable HTTP 地址，查询已授权的数据。", href: "https://mcp.dingtalk.com/" },
];

export function ConnectionPanel({ active = true }: { active?: boolean }) {
  const [statuses, setStatuses] = useState<ConnectionStatus[]>([]);
  const [selected, setSelected] = useState<ConnectionProvider | null>(null);
  const [transport, setTransport] = useState<"mcp" | "cli">("mcp");
  const [token, setToken] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [appId, setAppId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void connectionRequest("status", undefined, controller.signal).then(data => setStatuses(data.connections ?? [])).catch(() => {});
    return () => controller.abort();
  }, [active]);
  // The parent keeps settings mounted; clear sensitive drafts when its modal closes.
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { if (!active) { setToken(""); setEndpoint(""); setAppId(""); } }, [active]);
  const choose = (provider: ConnectionProvider) => {
    setSelected(selected === provider ? null : provider); setTransport(provider === "wecom" ? "cli" : "mcp");
    setToken(""); setEndpoint(""); setAppId(""); setNotice("");
  };
  const run = async (action: "configure" | "test" | "disconnect") => {
    if (!selected || busy) return;
    setBusy(true); setNotice("");
    try {
      if (action === "configure") {
        const configured = await connectionRequest("configure", { provider: selected, transport, ...(token ? { token } : {}), ...(endpoint ? { endpoint } : {}), ...(appId ? { appId } : {}) });
        setStatuses(configured.connections ?? []); setToken(""); setEndpoint(""); setAppId("");
      }
      const data = await connectionRequest(action === "configure" ? "test" : action, { provider: selected });
      setStatuses(data.connections ?? []); setNotice(action === "disconnect" ? "已断开。" : "已连接，可以在聊天页查询资料。"); connectionsChanged();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "连接失败，请重试。");
      void connectionRequest("status").then(data => setStatuses(data.connections ?? [])).catch(() => {}); connectionsChanged();
    } finally { setBusy(false); }
  };
  return <div className="vc-service-list" data-vivic-services>
      {SERVICES.map(service => {
        const status = statuses.find(item => item.provider === service.provider);
        return <div className="vc-service" key={service.provider}>
          <button className="vc-service-toggle" type="button" aria-expanded={selected === service.provider} disabled={busy} onClick={() => choose(service.provider)}>
            <span>{service.label}</span><span className="vc-service-state">{status?.connected ? "已连接" : status?.configured ? "待验证" : "连接"}</span>
          </button>
          {selected === service.provider && <div className="vc-service-form">
            <p className="vc-caption">{service.help} <a href={service.href} target="_blank" rel="noopener noreferrer">获取授权</a></p>
            {status?.configured && <div className="vc-actions"><Button size="sm" variant="outline" disabled={busy} onClick={() => void run("test")}>测试连接</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void run("disconnect")}>断开</Button><span className="vc-caption">{status.connected ? `${status.tools.length} 项查询能力` : "尚未通过验证"}</span></div>}
            {service.provider === "feishu" && <label>接入方式<select value={transport} onChange={event => setTransport(event.target.value as "mcp" | "cli")} disabled={busy}><option value="mcp">飞书 MCP</option><option value="cli">Lark CLI</option></select></label>}
            {service.provider === "dingtalk" ? <label>个人 MCP 地址<input type="password" autoComplete="off" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://mcp-gw.dingtalk.com/…" disabled={busy} /></label>
              : <label>{service.provider === "feishu" ? "用户访问令牌" : "访问令牌"}<input type="password" autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} placeholder={status?.configured ? "替换授权时填写" : "粘贴本人的令牌"} disabled={busy} /></label>}
            {service.provider === "feishu" && transport === "cli" && <label>应用 App ID<input value={appId} onChange={event => setAppId(event.target.value)} placeholder="cli_…" disabled={busy} /></label>}
            <div className="vc-actions"><Button size="sm" disabled={busy || (service.provider === "dingtalk" ? !endpoint.trim() : !token.trim()) || service.provider === "feishu" && transport === "cli" && !appId.trim()} onClick={() => void run("configure")}>{busy ? "连接中…" : status?.configured ? "更新授权" : "连接"}</Button><span className="vc-caption">授权仅在当前服务会话保留。</span></div>
            {notice && <p className="vc-caption" role="status">{notice}</p>}
          </div>}
        </div>;
      })}
  </div>;
}
