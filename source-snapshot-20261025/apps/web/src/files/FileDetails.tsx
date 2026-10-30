import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { isReadableFile, type FileCard } from "@vivic/contracts";
import { Button } from "@/components/ui/button";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { ControlDialogContent } from "@/control/ControlDialogContent";
import { getFileAsset, downloadFileAsset, fileSizeLabel, type FileAsset } from "./assetStore";
import { FileDocument, fileTypeLabel } from "./FileDocument";
import { DocumentText } from "./DocumentText";
import "./files.css";

export function FileDetails({ card, canvasId, open, onOpenChange }: { card: FileCard; canvasId: string | null; open: boolean; onOpenChange(open: boolean): void }) {
  const [asset, setAsset] = useState<FileAsset | null>(null), [error, setError] = useState("");
  const [question, setQuestion] = useState("总结这份文件的主要内容，并标出来源位置。"), [answer, setAnswer] = useState("");
  const [reading, setReading] = useState(false), [assistant, setAssistant] = useState(false);
  useEffect(() => {
    let active = true; setAsset(null); setError(""); setAnswer(""); setReading(false); setAssistant(false);
    if (open && canvasId) void getFileAsset(canvasId, card.displayProps.fileId).then(value => {
      if (!active) return;
      if (!value || value.sha256 !== card.displayProps.sha256) { setError("此浏览器没有这份原件，请重新上传原文件。"); return; }
      setAsset(value);
    }).catch(() => { if (active) setError("文件存储不可用，请重试。"); });
    else if (open) setError("当前空间尚未就绪。");
    return () => { active = false; };
  }, [open, canvasId, card.displayProps.fileId, card.displayProps.sha256]);
  useEffect(() => {
    if (!reading || !asset || !open || !isReadableFile(asset.mediaType)) return;
    const controller = new AbortController(); let current = true;
    void fetch("/api/files/read", { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal: controller.signal,
      body: JSON.stringify({ name: asset.name, text: asset.text, partial: asset.parseStatus === "partial", question }) }).then(async response => {
      const body = await response.json() as { ok?: boolean; answer?: string; error?: string; citations?: Array<{ label: string; quote: string }> };
      if (!response.ok || !body.ok || typeof body.answer !== "string") throw new Error(body.error ?? "暂时无法阅读，请检查模型连接。");
      if (current) setAnswer(body.answer + (body.citations?.length ? "\n\n" + body.citations.map(c => c.label + "：「" + c.quote + "」").join("\n") : ""));
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : "阅读失败。"); }).finally(() => { if (current) setReading(false); });
    return () => { current = false; controller.abort(); };
  }, [reading, asset, open, question]);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>{open && <ControlDialogContent title={card.displayProps.name}
    description={fileTypeLabel(card.displayProps.mediaType) + " · " + fileSizeLabel(card.displayProps.sizeBytes) + " · 只读"} className="vivic-file-dialog">
    <div className="vivic-file-toolbar"><span className="vivic-file-toolbar-label"><HarkIcon name="file" size={14} />{isReadableFile(card.displayProps.mediaType) ? "文件阅读" : "原文件"}</span>
      {isReadableFile(card.displayProps.mediaType) && <Button variant="ghost" size="sm" disabled={!asset} aria-pressed={assistant} onClick={() => setAssistant(value => !value)}><HarkIcon name="chat" size={15} />问 Vivic</Button>}
      <Button variant="ghost" size="icon" aria-label="下载原文件" title="下载原文件" disabled={!asset} onClick={() => asset && downloadFileAsset(asset)}><HarkIcon name="download" size={17} /></Button></div>
    <div className="vivic-file-layout" data-assistant={assistant || undefined}>
      <div className="vivic-file-reading-scroll" tabIndex={0} aria-label="文件阅读区域">
        {asset ? <FileDocument blob={asset.blob} mediaType={asset.mediaType} /> : <p className="vivic-file-loading" role="status">{error || "正在打开文件…"}</p>}
      </div>
      {assistant && isReadableFile(card.displayProps.mediaType) && <aside className="vivic-file-assistant" aria-label="询问文件">
        <div className="vivic-file-assistant-heading"><HarkIcon name="research" size={17} /><span>围绕这份文件</span></div>
        {asset?.parseStatus === "partial" && <p className="vivic-file-hint">Vivic 当前可读取前 100 页或 80,000 字以内的提取内容。</p>}
        {asset && !asset.text.trim() && <p className="vivic-file-hint">这份文件没有可提取的文字。扫描 PDF 可以直接看原页，暂不支持 OCR。</p>}
        {answer && <div className="vivic-file-answer" aria-label="文件阅读结果" role="status"><DocumentText text={answer} /></div>}
        <form className="vivic-file-reader" onSubmit={event => { event.preventDefault(); if (!reading && question.trim() && asset?.text.trim()) { setError(""); setAnswer(""); setReading(true); } }}>
          <label className="sr-only" htmlFor="vivic-file-question">关于文件的问题</label><textarea id="vivic-file-question" value={question} disabled={reading} maxLength={1000} onChange={e => setQuestion(e.target.value)} rows={3} />
          <Button type="submit" size="sm" disabled={reading || !question.trim() || !asset?.text.trim()}>{reading ? "正在阅读…" : "阅读并回答"}<HarkIcon name="up" size={14} /></Button>
        </form>
        {error && asset && <p role="alert" className="vivic-file-message">{error}</p>}
      </aside>}
    </div>
  </ControlDialogContent>}</Dialog.Root>;
}
