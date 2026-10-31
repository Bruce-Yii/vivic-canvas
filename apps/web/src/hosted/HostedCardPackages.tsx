import { useEffect, useRef, useState, type ReactNode } from "react";
import { definitionKey, definitionRef, PACKAGE_LIMITS, readPackageZip, resolvePointer, revalidateDefinition, type CardDefinition, type UiBlock } from "@vivic/card-runtime";
import { HostedApiError, hostedRequest } from "./client";
import { useRefreshHostedDefinitions } from "./HostedDefinitions";
import "./card-packages.css";

interface Row { key: string; definition: CardDefinition; enabled: boolean }
interface Preview { definition: CardDefinition; file?: File }
const packagePath = (row: Row) => `/api/space/cards/${encodeURIComponent(row.definition.manifest.id)}`;
const text = (value: unknown) => value === null || value === undefined || value === "" ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);
const versionCompare = (a: string, b: string) => { const av = a.split(".").map(BigInt), bv = b.split(".").map(BigInt); for (let i = 0; i < 3; i++) { if (av[i]! > bv[i]!) return 1; if (av[i]! < bv[i]!) return -1; } return 0; };

/** Same controlled UI blocks as a live extension; DEMO never fetches external media. */
function DemoBlock({ block, root }: { block: UiBlock; root: unknown }) {
  const value = block.bind ? resolvePointer(root, block.bind) : block.text;
  switch (block.component) {
    case "Header": return <h4>{text(value)}</h4>;
    case "Metric": return <div className="cp-metric"><span>{block.label}</span><strong>{text(value)}</strong></div>;
    case "Badge": return <span className="cp-badge">{block.label ? `${block.label} · ` : ""}{text(value)}</span>;
    case "List": return <ul>{Array.isArray(value) && value.length ? value.map((item, index) => <li key={index}>{text(item)}</li>) : <li>暂无内容</li>}</ul>;
    case "Table": return <div className="cp-table"><table><thead><tr>{block.columns?.map(column => <th key={column.field}>{column.label}</th>)}</tr></thead><tbody>{Array.isArray(value) && value.map((row, index) => <tr key={index}>{block.columns?.map(column => <td key={column.field}>{text(row && typeof row === "object" ? row[column.field] : undefined)}</td>)}</tr>)}</tbody></table></div>;
    case "Progress": return <label>{block.label}<progress max={100} value={typeof value === "number" ? Math.max(0, Math.min(100, value)) : 0} /></label>;
    case "Image": return <p className="cp-muted">{block.label ?? "图片"} · DEMO 不加载远程图片</p>;
    case "Link": return <p className="cp-muted">{block.label ?? "链接"} · DEMO 不打开链接</p>;
    default: return <div className="cp-key-value"><span>{block.label}</span><span>{text(value)}</span></div>;
  }
}

export function HostedCardPackages({ disabled = false }: { disabled?: boolean }) {
  const refreshDefinitions = useRefreshHostedDefinitions();
  const [rows, setRows] = useState<Row[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""), [error, setError] = useState(""), [expired, setExpired] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null), [exampleIndex, setExampleIndex] = useState(0), [enableInstall, setEnableInstall] = useState(true);
  const [remove, setRemove] = useState<Row | null>(null);
  const fileInput = useRef<HTMLInputElement>(null), lifecycle = useRef({ alive: true, running: false }), account = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const fail = (cause: unknown) => {
    if (!lifecycle.current.alive) return;
    if (cause instanceof HostedApiError && cause.status === 401) {
      setExpired(true); setRows([]); setPreview(null); setRemove(null);
      setError("登录已失效，请重新登录后管理卡片包。");
    } else setError(cause instanceof Error ? cause.message : "连接中断，请刷新列表确认操作结果。");
  };
  const load = async (signal?: AbortSignal) => {
    const response = await hostedRequest<{ definitions: unknown[] }>("/api/space/cards", undefined, "GET", signal);
    if (!Array.isArray(response.definitions) || response.definitions.length > 256 || JSON.stringify(response).length > 8 * 1024 * 1024) throw new Error("卡片包列表超出限制，请稍后重试。");
    const checked: Row[] = [];
    for (const value of response.definitions) {
      if (!value || typeof value !== "object" || !("definition" in value) || !("key" in value) || !("enabled" in value) || typeof value.enabled !== "boolean") throw new Error("卡片包列表校验失败，原始数据已保留。");
      const definition = await revalidateDefinition(value.definition);
      if (value.key !== definitionKey(definitionRef(definition))) throw new Error("卡片包内容校验失败，请重新安装原包。");
      checked.push({ key: value.key as string, definition, enabled: value.enabled });
    }
    if (lifecycle.current.alive && !signal?.aborted) { setRows(checked); setLoading(false); }
  };
  useEffect(() => {
    lifecycle.current.alive = true;
    const abort = new AbortController(); controller.current = abort;
    void hostedRequest<{ user?: { id: string }; authenticated: boolean }>("/api/space/session", undefined, "GET", abort.signal).then(async session => {
      if (!session.authenticated || !session.user) throw new HostedApiError(401, "login-required", "请重新登录。");
      account.current = session.user.id; await load(abort.signal);
    }).catch(cause => { if (!abort.signal.aborted) { fail(cause); setLoading(false); } });
    return () => { lifecycle.current.alive = false; abort.abort(); };
  }, []);
  const run = (operation: (signal: AbortSignal) => Promise<void>) => {
    if (disabled || expired || lifecycle.current.running || !lifecycle.current.alive) return;
    lifecycle.current.running = true; setBusy(true); setError(""); setMessage("");
    const abort = controller.current ?? new AbortController();
    void (async () => {
      const session = await hostedRequest<{ authenticated: boolean; user?: { id: string } }>("/api/space/session", undefined, "GET", abort.signal);
      if (!session.authenticated || !session.user || session.user.id !== account.current) throw new HostedApiError(401, "account-changed", "账号已切换，请重新载入。");
      if (!lifecycle.current.alive) return;
      await operation(abort.signal);
    })().catch(fail).finally(() => { lifecycle.current.running = false; if (lifecycle.current.alive) setBusy(false); });
  };
  const changed = async (signal: AbortSignal) => { refreshDefinitions(); await load(signal); };
  const install = () => {
    if (!preview?.file) return;
    const { definition, file } = preview;
    run(async signal => {
      const body = new FormData(); body.set("file", file); body.set("enabled", String(enableInstall));
      const response = await fetch("/api/space/cards", { method: "POST", body, credentials: "same-origin", cache: "no-store", signal });
      const result = await response.json();
      if (!response.ok || result.ok === false) throw new HostedApiError(response.status, result.code ?? "upload-failed", result.message ?? "安装未完成，请刷新列表确认。");
      refreshDefinitions();
      const installed = await revalidateDefinition(result.record?.definition);
      if (installed.hash !== definition.hash) throw new Error("安装内容与预览不一致，请刷新列表确认。");
      await load(signal);
      if (lifecycle.current.alive) { setPreview(null); setMessage(result.deduplicated ? "这个版本已安装，原启用状态已保留。" : "已安装到当前账号。可以回到聊天，用一句话创建卡片。"); }
    });
  };
  const unavailable = disabled || busy || loading || expired;
  const enabled = rows.filter(row => row.enabled).length;
  const demo = preview?.definition.examples[exampleIndex];
  const node: ReactNode = preview && <div className="cp-preview" aria-label="卡片包预览">
    <div className="cp-heading"><div><h3>{preview.definition.manifest.icon} {preview.definition.manifest.name}</h3><p className="cp-muted">v{preview.definition.manifest.version} · 格式 {preview.definition.manifest.formatVersion}</p></div><button type="button" className="cp-button" disabled={busy} onClick={() => setPreview(null)}>关闭预览</button></div>
    <p>{preview.definition.manifest.description}</p>
    <p className="cp-demo-label">DEMO 预览 · 示例数据，不会写入 Space</p>
    {preview.definition.examples.length > 1 && <label className="cp-select">示例<select aria-label="预览示例" value={exampleIndex} onChange={event => setExampleIndex(Number(event.target.value))}>{preview.definition.examples.map((example, index) => <option key={index} value={index}>{example.name}</option>)}</select></label>}
    {demo && <div className="cp-demo-card">{preview.definition.ui.components.map((block, index) => <DemoBlock block={block} root={demo} key={index} />)}</div>}
    {preview.definition.manifest.examples?.length ? <details className="cp-examples"><summary>可以这样说</summary><ul>{preview.definition.manifest.examples.map((example, index) => <li key={index}>{example}</li>)}</ul></details> : null}
    {preview.file && <div className="cp-install"><label><input type="checkbox" checked={enableInstall} disabled={unavailable} onChange={event => setEnableInstall(event.target.checked)} />安装后启用</label><button type="button" className="cp-button cp-primary" disabled={unavailable || rows.length >= 32 && !rows.some(row => row.definition.hash === preview.definition.hash) || enableInstall && enabled >= 16 && !rows.some(row => row.definition.hash === preview.definition.hash)} onClick={install}>确认安装</button></div>}
  </div>;
  return <section className="cp-manager" aria-labelledby="cp-title" aria-busy={busy || loading} data-card-package-manager>
    <div className="cp-heading"><div><h3 id="cp-title">卡片包</h3><p className="cp-muted">已安装 {rows.length}/32 · 已启用 {enabled}/16</p></div><div className="cp-actions"><button type="button" className="cp-button" disabled={unavailable} onClick={() => run(async signal => { await load(signal); refreshDefinitions(); setMessage("列表已刷新。"); })}>刷新列表</button><button type="button" className="cp-button cp-primary" disabled={unavailable} onClick={() => fileInput.current?.click()}>导入卡片包</button></div></div>
    <input ref={fileInput} hidden type="file" accept=".vivicard" aria-label="选择卡片包" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file || unavailable) return;
      run(async () => {
        if (!file.name.toLowerCase().endsWith(".vivicard") || !file.size || file.size > PACKAGE_LIMITS.compressedBytes) throw new Error("请选择不超过 1 MiB 的 .vivicard 文件。");
        const definition = await readPackageZip(new Uint8Array(await file.arrayBuffer()));
        if (lifecycle.current.alive) { setPreview({ definition, file }); setExampleIndex(0); setEnableInstall(enabled < 16); setRemove(null); }
      });
    }} />
    {loading ? <p role="status" className="cp-muted">正在读取卡片包…</p> : !rows.length && !expired ? <p className="cp-muted cp-empty">导入卡片包，让 Vivic 用适合你的卡片记录和回答。</p> : null}
    {error && <p role="alert" className="cp-error">{error}</p>}{message && <p role="status" className="cp-status">{message}</p>}
    {expired && <button type="button" className="cp-button" onClick={() => window.location.reload()}>重新登录</button>}
    {node}
    <div className="cp-list">{rows.map(row => {
      const manifest = row.definition.manifest, newer = rows.some(other => other.enabled && other.definition.manifest.id === manifest.id && versionCompare(other.definition.manifest.version, manifest.version) > 0);
      return <article className="cp-row" key={row.key} data-package-id={manifest.id} data-package-hash={row.definition.hash}>
        <div className="cp-heading"><div><h4>{manifest.icon} {manifest.name}</h4><p className="cp-muted">v{manifest.version} · {row.enabled ? newer ? "已启用 · 历史版本" : "已启用" : "已停用"}{manifest.category ? ` · ${manifest.category}` : ""}</p></div><button className="cp-button" type="button" disabled={unavailable || !row.enabled && enabled >= 16} aria-label={`${row.enabled ? "停用" : "启用"} ${manifest.name} v${manifest.version}`} onClick={() => run(async signal => { await hostedRequest(packagePath(row), { hash: row.definition.hash, enabled: !row.enabled }, "PATCH", signal); await changed(signal); setMessage(row.enabled ? "已停用。现有卡片数据保留，重新启用即可恢复显示。" : "已启用，可以在聊天中使用。"); })}>{row.enabled ? "停用" : "启用"}</button></div>
        <p className="cp-description">{manifest.description}</p><details className="cp-identity"><summary>版本详情</summary><p>{manifest.id}</p><code>{row.definition.hash}</code><p>格式 {manifest.formatVersion}{newer ? " · 新建卡片优先使用最高已启用版本，已有卡片保持原版本。" : ""}</p></details>
        <div className="cp-actions"><button className="cp-button" type="button" disabled={unavailable} onClick={() => { setPreview({ definition: row.definition }); setExampleIndex(0); setRemove(null); }}>预览 DEMO</button><button className="cp-button" type="button" disabled={unavailable} onClick={() => run(async signal => {
          const response = await fetch(`${packagePath(row)}/package?hash=${row.definition.hash}`, { credentials: "same-origin", cache: "no-store", signal });
          if (!response.ok) { const result = await response.json(); throw new HostedApiError(response.status, result.code, result.message); }
          const bytes = new Uint8Array(await response.arrayBuffer()), definition = await readPackageZip(bytes);
          if (definition.hash !== row.definition.hash) throw new Error("下载内容校验失败，请重试。");
          if (!lifecycle.current.alive) return;
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/zip" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${manifest.id}-${manifest.version}.vivicard`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage("卡片包已下载。");
        })}>下载</button><button className="cp-button cp-danger" type="button" disabled={unavailable} onClick={() => { setRemove(row); setError(""); }}>卸载</button></div>
        {remove?.key === row.key && <div className="cp-remove" role="group" aria-label="确认卸载"><p>卸载 {manifest.name} v{manifest.version}？已有卡片引用的版本会保留。</p><div className="cp-actions"><button type="button" className="cp-button" disabled={busy} onClick={() => setRemove(null)}>取消</button><button type="button" className="cp-button cp-danger" disabled={unavailable} onClick={() => run(async signal => { await hostedRequest(`${packagePath(row)}?hash=${row.definition.hash}`, undefined, "DELETE", signal); await changed(signal); setRemove(null); if (preview?.definition.hash === row.definition.hash) setPreview(null); setMessage("已卸载此版本。"); })}>确认卸载</button></div></div>}
      </article>;
    })}</div>
  </section>;
}
