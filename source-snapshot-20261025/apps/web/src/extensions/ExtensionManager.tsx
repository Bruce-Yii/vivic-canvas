import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "radix-ui";
import { definitionKey, definitionRef, readPackageZip, type CardDefinition } from "@vivic/card-runtime";
import type { ControlHost } from "@/sync/controlHost";
import { ControlDialogContent } from "@/control/ControlDialogContent";
import { CardModeContext } from "@/cards/scene/cardContext";
import { ATMOSPHERE_PALETTES, DARK_PALETTE_IDS, LIGHT_PALETTE_IDS, type PaletteId } from "@/components/atmosphere/palettes";
import { newId } from "@/lib/id";
import { extensionDefinitions } from "./definitionStore";
import { createExtensionInstance } from "./extensionInstance";
import { ExtensionCardView } from "./ExtensionCardView";
import { SchemaForm } from "./SchemaForm";
import { TestSpaceSession } from "./TestSpaceSession";
import { loadBuiltinOfficeDefinitions, OFFICE_PLANNER_CATALOG } from "@/cards/office/builtinOfficePackages";
import "./extensions.css";

export function ExtensionManager({ host, disabled = false }: { host: ControlHost; disabled?: boolean }) {
  useSyncExternalStore(extensionDefinitions.subscribe, extensionDefinitions.snapshot, extensionDefinitions.snapshot);
  const [session, setSession] = useState<TestSpaceSession | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  const [mode, setMode] = useState<"control" | "display">("control"), [palette, setPalette] = useState<PaletteId>("milk"), [revision, setRevision] = useState(0);
  const [configValid, setConfigValid] = useState(true), [stateValid, setStateValid] = useState(true);
  const [exampleRevision, setExampleRevision] = useState(0);
  const generation = useRef(0), sessionRef = useRef<TestSpaceSession | null>(null), fileRef = useRef<HTMLInputElement>(null), importRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { void extensionDefinitions.ready(); return () => { generation.current++; sessionRef.current?.close(); }; }, []);
  useEffect(() => {
    const reset = () => { generation.current++; sessionRef.current?.close(); sessionRef.current = null; setSession(null); setBusy(false); };
    document.addEventListener("vivic:data-reset", reset);
    return () => document.removeEventListener("vivic:data-reset", reset);
  }, []);
  useEffect(() => { if (disabled) { generation.current++; sessionRef.current?.close(); sessionRef.current = null; setSession(null); setBusy(false); } }, [disabled]);
  const close = () => { generation.current++; sessionRef.current?.close(); sessionRef.current = null; setSession(null); setBusy(false); importRef.current?.focus(); };
  const importFile = async (file: File) => {
    close(); const current = ++generation.current; setBusy(true); setMessage(`正在解析 ${file.name}…`);
    try {
      if (file.size > 1048576) throw new Error("文件超过 1 MiB");
      const definition = await readPackageZip(new Uint8Array(await file.arrayBuffer()));
      if (current !== generation.current) return;
      const next = new TestSpaceSession(definition); sessionRef.current = next; setSession(next); setConfigValid(true); setStateValid(true);
      setMessage(`结构校验通过 · ${definition.manifest.id} v${definition.manifest.version}`);
    } catch (cause) { if (current === generation.current) setMessage(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const previewBuiltin = async (id: string) => {
    if (disabled || busy) return;
    close(); const current = ++generation.current; setBusy(true); setMessage("正在校验 Vivic 内置卡片…");
    try {
      const definition = (await loadBuiltinOfficeDefinitions()).find(item => item.manifest.id === id);
      if (!definition) throw new Error("找不到这张内置卡片");
      if (current !== generation.current) return;
      const next = new TestSpaceSession(definition); sessionRef.current = next; setSession(next); setConfigValid(true); setStateValid(true);
      setMessage(`结构校验通过 · ${definition.manifest.name}`);
    } catch (cause) { if (current === generation.current) setMessage(cause instanceof Error ? cause.message : "卡片校验失败，请重试。"); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const operate = async (fn: () => Promise<unknown>, success: string) => { try { await fn(); setMessage(success); } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); } };
  const createCard = (definition: CardDefinition) => {
    const snapshot = host.getSnapshot();
    if (disabled || snapshot.ownerMode !== "owner" || !snapshot.activeCanvasId) return;
    const card = createExtensionInstance(definition, definition.examples[0]!);
    const result = host.dispatch({ schemaVersion: "0.6", requestId: newId("extension"), canvasId: snapshot.activeCanvasId, actions: [{ type: "card.create", card }] });
    setMessage(result.ok ? "已从示例创建一张卡片，可在聊天页编辑参数。示例数据为 DEMO。" : result.error);
  };
  const refresh = () => setRevision(revision + 1);
  return <section className="rounded-xl border border-neutral-200 bg-white p-4" data-extension-manager>
    <div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">扩展卡片管理</h2><p className="mt-1 text-xs opacity-65">导入 .vivicard 包，校验并试跑后安装。</p></div>
      <button ref={importRef} type="button" disabled={disabled || busy} className="vivic-scene-action" onClick={() => fileRef.current?.click()}>导入卡片包</button></div>
    <input ref={fileRef} hidden type="file" accept=".vivicard,.zip" aria-label="选择卡片包" data-extension-file onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file && !disabled) void importFile(file); }} />
    <div className="mt-4 grid gap-2 sm:grid-cols-3" aria-label="Vivic 办公卡片">
      {OFFICE_PLANNER_CATALOG.map(entry => <button key={entry.id} type="button" data-office-builtin={entry.kind} disabled={disabled || busy}
        className="rounded-xl border border-[var(--border)] p-3 text-left text-xs transition-colors hover:bg-black/5 disabled:opacity-50"
        onClick={() => void previewBuiltin(entry.id)}><strong className="block text-sm">{entry.name}</strong><span className="mt-1 block opacity-65">{entry.description}</span><span className="mt-3 block">预览与安装 →</span></button>)}
    </div>
    {message && <p role="status" className="my-3 text-xs break-words">{message}</p>}
    {extensionDefinitions.error() && <p role="alert" className="my-3 text-xs text-amber-700">{extensionDefinitions.error()}</p>}
    <div className="mt-3 space-y-3">{extensionDefinitions.list().map(({ definition, enabled }) => <div key={definitionKey(definitionRef(definition))} className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs" data-extension-installed={definition.manifest.id}>
      <span className="mr-auto"><strong>{definition.manifest.name}</strong> · {definition.manifest.version}<br /><span className="opacity-60">{definition.manifest.id} · {definition.hash.slice(0, 8)} · {enabled ? "已启用" : "已禁用"}</span></span>
      <button type="button" className="vivic-scene-action" disabled={disabled || !enabled} onClick={() => createCard(definition)}>从 DEMO 创建卡片</button>
      <button type="button" className="vivic-scene-action" disabled={disabled} onClick={() => { void operate(() => extensionDefinitions.setEnabled(definitionRef(definition), !enabled), enabled ? "已禁用，实例数据保留。" : "已启用。"); }}>{enabled ? "禁用" : "启用"}</button>
      <button type="button" className="vivic-scene-action" disabled={disabled} onClick={() => { void operate(() => extensionDefinitions.uninstall(definitionRef(definition)), "已卸载定义；实例数据保留，重新导入原包可恢复。"); }}>卸载</button>
    </div>)}</div>
    <Dialog.Root open={Boolean(session)} onOpenChange={open => { if (!open) close(); }}>
      {session && <ControlDialogContent title="Vivic Test Space" description="隔离 DEMO 预览。试跑不会请求模型、服务或写入真实画布。" className="vivic-extension-dialog" onCloseAutoFocus={event => { event.preventDefault(); importRef.current?.focus(); }}>
        <div className="space-y-4 p-5" data-test-space={session.token}>
          <p className="text-xs break-all">结构校验通过 · {session.definition.manifest.name} v{session.definition.manifest.version}<br />SHA-256: {session.definition.hash}</p>
          <p className="text-xs opacity-70">真实连接未验证 · v0.1 为声明式展示包，不支持外部服务能力。</p>
          <div className="flex flex-wrap gap-3 text-xs">
            <label>样例 <select aria-label="预览样例" onChange={event => { session.loadExample(session.definition.examples[Number(event.target.value)]!); setConfigValid(true); setStateValid(true); setExampleRevision(exampleRevision + 1); refresh(); }}>{session.definition.examples.map((example, i) => <option key={i} value={i}>{example.name}</option>)}</select></label>
            <label>模式 <select aria-label="预览模式" value={mode} onChange={event => setMode(event.target.value === "display" ? "display" : "control")}><option value="control">User</option><option value="display">Display</option></select></label>
            <label>主题配色 <select aria-label="预览主题配色" value={palette} onChange={event => setPalette(event.target.value as PaletteId)}>{[...LIGHT_PALETTE_IDS, ...DARK_PALETTE_IDS].map(id => <option key={id} value={id}>{ATMOSPHERE_PALETTES[id].name} · {LIGHT_PALETTE_IDS.some(light => light === id) ? "浅色" : "深色"}</option>)}</select></label>
          </div>
          <div className={`vivic-extension-preview ${DARK_PALETTE_IDS.some(dark => dark === palette) ? "dark" : ""}`} data-appearance={DARK_PALETTE_IDS.some(dark => dark === palette) ? "dark" : "light"} style={{ background: `linear-gradient(130deg,${ATMOSPHERE_PALETTES[palette].colors.join(",")})` }}>
            <CardModeContext.Provider value={mode}><div className="vivic-extension-preview-card"><ExtensionCardView key={revision} card={session.card} definition={session.definition} /></div></CardModeContext.Provider>
          </div>
          <SchemaForm key={`config:${session.token}:${exampleRevision}`} schema={session.definition.configSchema} value={session.card.displayProps.config} onValidityChange={setConfigValid} onChange={config => { session.setConfig(config); refresh(); }} />
          <SchemaForm key={`state:${session.token}:${exampleRevision}`} label="个人状态" schema={session.definition.stateSchema} value={session.card.displayProps.state} onValidityChange={setStateValid} onChange={state => { session.setState(state); refresh(); }} />
          <p role="status" className="text-xs">{!configValid || !stateValid ? "参数有错误，请修正后试跑" : session.canInstall ? "样例运行通过 · 可以安装" : "请试跑当前样例和参数"}</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={!configValid || !stateValid} className="vivic-scene-action" onClick={() => { const current = generation.current; void session.run().then(ok => { if (ok && current === generation.current) refresh(); }).catch(cause => setMessage(String(cause))); }}>试跑 DEMO</button>
            <button type="button" className="vivic-scene-action" onClick={() => { session.cancel(); refresh(); }}>取消试跑</button>
            <button type="button" className="vivic-scene-action" disabled={disabled || busy || !configValid || !stateValid || !session.canInstall} onClick={() => {
              const current = generation.current; setBusy(true);
              void (async () => { try {
                if (!session.canInstall || !configValid || !stateValid || session !== sessionRef.current) throw new Error("试跑已失效");
                await extensionDefinitions.install(session.definition, session.definition.hash, () => current === generation.current && session === sessionRef.current && session.canInstall);
                if (current !== generation.current) return;
                close(); setMessage("安装完成。点击“从 DEMO 创建卡片”可创建正式实例。");
              } catch (cause) { if (current === generation.current) setMessage(String(cause)); } finally { if (current === generation.current) setBusy(false); } })();
            }}>安装卡片</button>
          </div>
        </div>
      </ControlDialogContent>}
    </Dialog.Root>
  </section>;
}
