import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { isReadableFile, type FileCard, type HostedSpaceSnapshot } from "@vivic/contracts";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import { DocumentText } from "@/files/DocumentText";
import { errorMessage, hostedRequest } from "@/hosted/client";
import { assetPath, deleteAsset, getAssetList, queryUpload, verifyAssetContent, type HostedAssetRecord } from "./client";
import "@/files/files.css";
import "./assets.css";

const FileDocument = lazy(() => import("@/files/FileDocument").then(module => ({ default: module.FileDocument })));
export function HostedAssetPanels({ spaceId, file, manage, container, uploadPending, onCloseFile, onCloseManage, onRecovered }: {
  spaceId: string; file: FileCard | null; manage: boolean; container: HTMLElement; uploadPending: string; onCloseFile(): void; onCloseManage(): void; onRecovered(snapshot: HostedSpaceSnapshot): void;
}) {
  return <>{file && <HostedFileReader key={file.id} spaceId={spaceId} card={file} container={container} onClose={onCloseFile} />}
    {manage && <HostedAssetManager spaceId={spaceId} container={container} pending={uploadPending} onClose={onCloseManage} onRecovered={onRecovered} />}</>;
}
function AssetDialog({ title, description, children, container, onClose, reader = false }: { title: string; description: string; children: ReactNode; container: HTMLElement; onClose(): void; reader?: boolean }) {
  const trigger = useRef(document.activeElement as HTMLElement | null);
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal container={container}><Dialog.Overlay className="hosted-asset-overlay" />
    <Dialog.Content asChild onCloseAutoFocus={event => { event.preventDefault(); if (trigger.current?.isConnected && trigger.current !== document.body) trigger.current.focus(); else document.querySelector<HTMLElement>(".hosted-header button[aria-label=设置]")?.focus(); }}><HarkSurface as="div" className={`hosted-asset-dialog${reader ? " hosted-asset-reader" : ""}`}>
      <header className="hosted-asset-header"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div><Dialog.Close asChild><button className="hark-icon-button" aria-label="关闭阅读窗口"><HarkIcon name="close" /></button></Dialog.Close></header>{children}
    </HarkSurface></Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
function HostedFileReader({ spaceId, card, container, onClose }: { spaceId: string; card: FileCard; container: HTMLElement; onClose(): void }) {
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof verifyAssetContent>> | null>(null), [error, setError] = useState(""), [retry, setRetry] = useState(0), [assistant, setAssistant] = useState(false);
  const [question, setQuestion] = useState(""), [answer, setAnswer] = useState(""), [asking, setAsking] = useState(false), [saving, setSaving] = useState(false);
  const askController = useRef<AbortController | null>(null), saveController = useRef<AbortController | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; askController.current?.abort(); saveController.current?.abort(); }; }, []);
  useEffect(() => { const controller = new AbortController(); setLoaded(null); setError(""); void verifyAssetContent(spaceId, card.displayProps.fileId, card.displayProps.sha256, controller.signal).then(setLoaded).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); }); return () => controller.abort(); }, [spaceId, card.displayProps.fileId, card.displayProps.sha256, retry]);
  const download = async () => {
    if (saving) return; setSaving(true); setError(""); const controller = new AbortController(); saveController.current = controller;
    try { const file = await verifyAssetContent(spaceId, card.displayProps.fileId, card.displayProps.sha256, controller.signal), { nativeFiles, saveNativeFile } = await import("@/control/mobile/saveNativeFile");
      if (nativeFiles()?.saveFile) await saveNativeFile(file.bytes, file.asset.name, file.asset.mediaType, file.asset.sha256, controller.signal);
      else { const url = URL.createObjectURL(new Blob([file.bytes], { type: "application/octet-stream" })), link = document.createElement("a"); link.href = url; link.download = file.asset.name; link.rel = "noopener"; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (error) { if (alive.current) setError(errorMessage(error)); } finally { if (alive.current) setSaving(false); }
  };
  const ask = async () => {
    if (!question.trim() || asking || !loaded?.asset.text.trim()) return; setAsking(true); setError(""); const controller = new AbortController(); askController.current = controller;
    try { const result = await hostedRequest<{ ok?: boolean; answer: string; citations?: { label: string; quote: string }[] }>(`${assetPath(spaceId, card.displayProps.fileId)}/ask`, { question: question.trim() }, "POST", AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]));
      if (alive.current) setAnswer(result.answer + (result.citations?.length ? "\n\n" + result.citations.map(item => `${item.label}：「${item.quote}」`).join("\n") : ""));
    } catch (error) { if (alive.current) setError(controller.signal.aborted ? "已取消本次等待。" : errorMessage(error)); } finally { if (alive.current) setAsking(false); }
  };
  return <AssetDialog title={card.displayProps.name} description={`${card.displayProps.mediaType === "application/pdf" ? "PDF" : card.displayProps.mediaType === "text/markdown" ? "Markdown" : "原文件"} · ${sizeLabel(card.displayProps.sizeBytes)} · 只读`} container={container} onClose={onClose} reader>
    <div className="hosted-asset-toolbar"><span>{isReadableFile(card.displayProps.mediaType) ? "文件阅读" : "原文件"}</span>{isReadableFile(card.displayProps.mediaType) && <button className="hosted-quiet" disabled={!loaded} aria-pressed={assistant} onClick={() => setAssistant(value => !value)}><HarkIcon name="chat" />问 Vivic</button>}<button className="hark-icon-button" aria-label="下载原文件" disabled={saving || !loaded} onClick={() => void download()}><HarkIcon name="download" /></button></div>
    <div className="vivic-file-layout" data-assistant={assistant || undefined}><div className="vivic-file-reading-scroll" tabIndex={0} aria-label="文件阅读区域">
      {loaded ? <Suspense fallback={<p role="status" className="vivic-file-loading">正在打开阅读器…</p>}><FileDocument blob={loaded.blob} mediaType={loaded.asset.mediaType} /></Suspense> : <div className="vivic-file-loading" role="status">{error || "正在校验原文件…"}{error && <button className="hosted-quiet" onClick={() => setRetry(value => value + 1)}>重试</button>}</div>}
    </div>{assistant && <aside className="vivic-file-assistant"><h3>围绕这份文件</h3>{loaded?.asset.parseStatus === "partial" && <p className="hosted-muted">模型仅能读取已提取的前 100 页或 80,000 字以内内容。</p>}{loaded && !loaded.asset.text.trim() && <p className="hosted-muted">没有可提取文字，可直接阅读原页；本次不会自动调用 OCR。</p>}
      {answer && <div className="vivic-file-answer" role="status"><DocumentText text={answer} /></div>}<form className="hosted-form" onSubmit={event => { event.preventDefault(); void ask(); }}><label>关于文件的问题<textarea value={question} onChange={event => setQuestion(event.target.value)} maxLength={1000} rows={3} placeholder="想了解什么？" /></label><button className="hosted-primary" disabled={asking || !question.trim() || !loaded?.asset.text.trim()}>{asking ? "正在回答…" : "阅读并回答"}</button>{asking && <button className="hosted-quiet" type="button" onClick={() => askController.current?.abort()}>取消等待</button>}</form></aside>}</div>
    {error && loaded && <p role="alert" className="hosted-asset-error">{error}</p>}
  </AssetDialog>;
}
function HostedAssetManager({ spaceId, container, pending, onClose, onRecovered }: { spaceId: string; container: HTMLElement; pending: string; onClose(): void; onRecovered(snapshot: HostedSpaceSnapshot): void }) {
  const [assets, setAssets] = useState<HostedAssetRecord[]>([]), [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const refresh = async () => setAssets((await getAssetList(spaceId)).assets);
  useEffect(() => { const controller = new AbortController(); void getAssetList(spaceId, controller.signal).then(result => setAssets(result.assets)).catch(error => { if (!controller.signal.aborted) setMessage(errorMessage(error)); }); return () => controller.abort(); }, [spaceId]);
  const bytes = assets.reduce((total, asset) => total + asset.sizeBytes, 0);
  return <AssetDialog title="原件" description={`${sizeLabel(bytes)} / 100 MB`} container={container} onClose={onClose}><div className="hosted-asset-manager">
    <p className="hosted-muted">删卡会保留原件，便于撤销。仍被卡片引用的原件无法清理。</p><progress value={bytes} max={100_000_000} aria-label="Space 原件容量" />
    {pending && <div className="hosted-asset-recovery"><p>上次上传结果尚待确认。</p><button className="hosted-quiet" disabled={busy} onClick={() => { setBusy(true); void queryUpload(spaceId, pending).then(result => { onRecovered(result.snapshot); setAssets(result.assets); setMessage("已确认保存。"); void refresh(); }).catch(error => setMessage(errorMessage(error))).finally(() => setBusy(false)); }}>查询原上传结果</button></div>}
    {assets.map(asset => <div className="hosted-asset-row" key={asset.id}><HarkIcon name={asset.kind === "image" ? "photo" : "file"} /><div><strong>{asset.name}</strong><small>{sizeLabel(asset.sizeBytes)}</small></div><button className="hark-icon-button" aria-label={`清理原件：${asset.name}`} disabled={busy} onClick={() => setSelected(asset.id)}><HarkIcon name="trash" /></button>
      {selected === asset.id && <div className="hosted-asset-confirm"><span>清理这份原件？</span><button className="hosted-quiet" disabled={busy} onClick={() => { setBusy(true); void deleteAsset(spaceId, asset.id).then(async () => { setSelected(null); setMessage("已清理。"); await refresh(); }).catch(error => setMessage(errorMessage(error))).finally(() => setBusy(false)); }}>清理</button><button className="hosted-quiet" disabled={busy} onClick={() => setSelected(null)}>取消</button></div>}</div>)}
    {!assets.length && <p className="hosted-muted">这里还没有原件。</p>}{message && <p role="status" className="hosted-muted">{message}</p>}
  </div></AssetDialog>;
}
const sizeLabel = (bytes: number) => bytes < 1_000_000 ? `${Math.max(0.1, bytes / 1000).toFixed(bytes < 1000 ? 1 : 0)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
