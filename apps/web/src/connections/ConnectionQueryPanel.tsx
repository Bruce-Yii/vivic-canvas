import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import { Dialog } from "radix-ui";
import { ControlDialogContent } from "@/control/ControlDialogContent";
import { DocumentText } from "@/files/DocumentText";
import "@/files/files.css";
import { connectionRequest, type ConnectionResult, type ConnectionStatus, type ReadTool } from "./api";
import "./connections.css";

const FIELD_NAMES: Record<string, string> = { query: "关键词", keyword: "关键词", keywords: "关键词", doc: "文档链接", docID: "文档链接或编号", document_id: "文档编号", page_size: "最多返回", pageSize: "最多返回", limit: "最多返回", date: "日期", month: "月份", city: "城市", storeId: "门店编号", latitude: "纬度", longitude: "经度" };
const propertiesFor = (tool?: ReadTool) => tool?.inputSchema.properties && typeof tool.inputSchema.properties === "object" ? Object.entries(tool.inputSchema.properties as Record<string, Record<string, unknown>>).slice(0, 15) : [];

export function ConnectionQueryPanel({ onSave, onConfigure }: { onSave?: (result: ConnectionResult) => void | Promise<void>; onConfigure?: () => void }) {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [provider, setProvider] = useState("");
  const [toolName, setToolName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const refresh = () => { void connectionRequest("status", undefined, controller.signal).then(data => { if (!controller.signal.aborted) setConnections((data.connections ?? []).filter(item => item.connected)); }).catch(() => { if (!controller.signal.aborted) setError("连接状态暂时无法读取。"); }); };
    refresh(); window.addEventListener("vivic:connections-changed", refresh);
    return () => { controller.abort(); window.removeEventListener("vivic:connections-changed", refresh); };
  }, [open]);
  const connection = connections.find(item => item.provider === provider) ?? connections[0];
  const tool = connection?.tools.find(item => item.name === toolName) ?? connection?.tools[0];
  const fields = propertiesFor(tool);
  const required = Array.isArray(tool?.inputSchema.required) ? tool.inputSchema.required as string[] : [];
  const query = async (repeat?: { tool: string; args: Record<string, unknown> }) => {
    if (!connection || !tool || busy) return;
    setBusy(true); setError(""); setResult(null); setSaved(false);
    const controller = new AbortController(); pending.current = controller;
    try {
      const args: Record<string, unknown> = {};
      for (const [name, rule] of repeat ? [] : fields) {
        const value = values[name]?.trim();
        if (!value) { if (required.includes(name)) throw new Error(`请填写${FIELD_NAMES[name] ?? name}。`); continue; }
        args[name] = rule.type === "number" || rule.type === "integer" ? Number(value) : rule.type === "boolean" ? value === "true" : rule.type === "object" || rule.type === "array" ? JSON.parse(value) : value;
      }
      const data = await connectionRequest("query", { provider: connection.provider, tool: repeat?.tool ?? tool.name, args: repeat?.args ?? args }, controller.signal);
      if (!data.result) throw new Error("服务没有返回可读内容。");
      if (!controller.signal.aborted && pending.current === controller) setResult(data.result);
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "查询失败。"); }
    finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  };
  const ask = async () => {
    if (!connection || !question.trim() || busy) return;
    setBusy(true); setError(""); setResult(null); setSaved(false);
    const controller = new AbortController(); pending.current = controller;
    try {
      const data = await connectionRequest("ask", { provider: connection.provider, question: question.trim() }, controller.signal);
      if (!data.result) throw new Error("服务没有返回可读内容。");
      if (!controller.signal.aborted && pending.current === controller) setResult(data.result);
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "查询失败。"); }
    finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  };
return <section className="vc-query" aria-label="查询已连接的服务">
    <Dialog.Root open={open} onOpenChange={value => { setOpen(value); if (!value) pending.current?.abort(); }}>
      <Dialog.Trigger asChild><button type="button" className="vc-query-toggle"><HarkIcon name="search" size={16} />选择已连接</button></Dialog.Trigger>
      {open && <ControlDialogContent title="选择已连接" description="从连接的服务中查找，留在你的 Space。" className="vc-query-dialog">
        <div className="vc-query-body">
          {!connections.length ? <div className="vc-query-empty"><HarkIcon name="link" size={28} /><h3>连接你的资料来源</h3><p>飞书、企业微信、钉钉或麦当劳，按需连接。</p>{onConfigure && <Button size="sm" onClick={() => { setOpen(false); onConfigure(); }}>连接服务</Button>}</div> : <>
            <div className="vc-query-source"><HarkIcon name="apps" size={16} /><label htmlFor="vc-query-provider">来源</label><select id="vc-query-provider" aria-label="查询来源" value={connection?.provider ?? ""} disabled={busy}
              onChange={event => { setProvider(event.target.value); setToolName(""); setValues({}); setResult(null); }} >{connections.map(item => <option key={item.provider} value={item.provider}>{item.label}</option>)}</select><span className="vc-source-status">已连接</span></div>
            <form className="vc-question" onSubmit={event => { event.preventDefault(); void ask(); }}>
              <label className="sr-only" htmlFor="vc-question-text">资料查询问题</label>
              <textarea id="vc-question-text" aria-label="资料查询问题" rows={2} maxLength={2000} placeholder={connection?.provider === "mcdonalds" ? "这个月，有什么值得关注的活动？" : "帮我找一下杭州旅行计划…"} value={question} disabled={busy} onChange={event => setQuestion(event.target.value)} />
              <div className="vc-question-footer"><span>{busy ? "正在查找资料…" : "用一句话告诉 Vivic"}</span><Button type="submit" size="icon" disabled={busy || !question.trim()} aria-label="查询"><HarkIcon name={busy ? "refresh" : "up"} size={16} /></Button></div>
            </form>
          </>}
          {error && <p className="vc-query-error" role="alert"><HarkIcon name="info" size={15} />{error}</p>}
          {result && <HarkSurface as="article" className="vc-result">
            <header><span className="vc-result-mark"><HarkIcon name="file" size={20} /></span><div><h3>{result.title}</h3><p>{result.source} · {new Date(result.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p></div></header>
            <div className="vc-result-body"><DocumentText text={result.text} markdown /></div>
            {result.truncated && <p className="vc-caption">已显示部分内容，可缩小范围继续查询。</p>}
            {!!result.links.length && <div className="vc-source-links">{result.links.map((link, index) => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer"><HarkIcon name="link-out" size={12} />{link.title || "来源 " + (index + 1)}</a>)}</div>}
            <footer className="vc-result-actions">{result.query && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void query(result.query)}><HarkIcon name="refresh" size={14} />再次查询</Button>}
              {onSave && <Button size="sm" disabled={saved || busy} onClick={() => { setBusy(true); void Promise.resolve().then(() => onSave(result)).then(() => setSaved(true)).catch(() => setError("卡片未保存，请重试。")).finally(() => setBusy(false)); }}><HarkIcon name={saved ? "check" : "add"} size={14} />{saved ? "已加入 Space" : "保存为卡片"}</Button>}</footer>
          </HarkSurface>}
          {!!connections.length && <details className="vc-specific"><summary>指定查询内容<HarkIcon name="down" size={12} /></summary>
            <div className="vc-specific-fields"><label>内容<select aria-label="查询内容" value={tool?.name ?? ""} disabled={busy} onChange={event => { setToolName(event.target.value); setValues({}); setResult(null); }}>{connection?.tools.map(item => <option key={item.name} value={item.name}>{item.title}</option>)}</select></label>
            {fields.map(([name, rule]) => <label key={name}>{FIELD_NAMES[name] ?? (typeof rule.title === "string" ? rule.title : name)}{required.includes(name) ? " *" : ""}
              {Array.isArray(rule.enum) || rule.type === "boolean" ? <select value={values[name] ?? ""} disabled={busy} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.value }))}><option value="">请选择</option>{(Array.isArray(rule.enum) ? rule.enum : [true, false]).map(value => <option key={String(value)} value={String(value)}>{String(value)}</option>)}</select>
                : rule.type === "object" || rule.type === "array" ? <textarea rows={2} value={values[name] ?? ""} disabled={busy} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.value }))} />
                  : <input value={values[name] ?? ""} type={rule.type === "integer" || rule.type === "number" ? "number" : "text"} maxLength={8192} disabled={busy} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.value }))} />}
            </label>)}</div><Button size="sm" variant="outline" disabled={busy} onClick={() => void query()}>指定查询</Button>
          </details>}
        </div>
      </ControlDialogContent>}
    </Dialog.Root>
  </section>;
}
