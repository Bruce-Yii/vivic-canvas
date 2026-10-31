import { useState } from "react";
import { Dialog } from "radix-ui";
import type { CardOfType } from "@/contracts";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { ControlDialogContent } from "@/control/ControlDialogContent";
import { DocumentText } from "@/files/DocumentText";
import "@/files/files.css";
import "./connections.css";

export function ConnectedResultCard({ card }: { card: CardOfType<"NoteCard"> }) {
  const [open, setOpen] = useState(false);
  const value = card.sourceData.connectedSource as Record<string, unknown>;
  const title = typeof value.title === "string" ? value.title.slice(0, 160) : "查询资料";
  const body = typeof value.text === "string" ? value.text.slice(0, 24000) : card.displayProps.text ?? "";
  const source = card.sources[0]?.provider ?? "资料来源";
  const summary = (card.displayProps.text ?? "").replace(title + "\n", "").replace(/^#{1,6}\s+/gm, "").replace(/\n{2,}/g, "\n").trim();
  const links = card.sources.filter(item => item.url && /^https?:\/\//.test(item.url));
  return <><button type="button" className="vc-saved-card nodrag nopan" aria-label={"打开查询结果：" + title} onClick={() => setOpen(true)}>
    <span className="vc-saved-source"><HarkIcon name="file" size={15} />{source}</span><strong>{title}</strong><span className="vc-saved-summary">{summary}</span>
  </button><Dialog.Root open={open} onOpenChange={setOpen}>{open && <ControlDialogContent title={title} description={source + " · 查询时保存的内容"} className="vc-source-reader">
    <div className="vivic-details-scroll"><DocumentText text={body} markdown />
      {links.length > 0 && <footer className="vc-source-links">{links.map((link, index) => <a key={index} href={link.url} target="_blank" rel="noopener noreferrer"><HarkIcon name="link-out" size={12} />{link.title}</a>)}</footer>}
    </div>
  </ControlDialogContent>}</Dialog.Root></>;
}
