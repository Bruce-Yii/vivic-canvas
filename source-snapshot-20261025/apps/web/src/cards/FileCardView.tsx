import { useContext, useState } from "react";
import type { CardViewProps } from "./scene/types";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { FileScopeContext } from "@/files/FileScopeContext";
import { fileSizeLabel } from "@/files/assetStore";
import { fileTypeLabel } from "@/files/FileDocument";
import { FileDetails } from "@/files/FileDetails";
import "@/files/files.css";
import { isReadableFile } from "@vivic/contracts";

export function FileCardView({ card, height }: CardViewProps<"FileCard">) {
  const canvasId = useContext(FileScopeContext), [open, setOpen] = useState(false), props = card.displayProps;
  return <><button type="button" className="vivic-file-card-open nodrag nopan" aria-label={"打开文件：" + props.name} onClick={() => setOpen(true)}
    style={height ? { minHeight: Math.min(height, 180) } : undefined}>
    <span className="vivic-file-card-heading"><span className="vivic-file-mark"><HarkIcon name="file" size={22} /></span><span className="vivic-file-card-title">{props.name}<small>{fileTypeLabel(props.mediaType)} · {fileSizeLabel(props.sizeBytes)}{props.pageCount ? " · " + props.pageCount + " 页" : ""}</small></span><HarkIcon name="chevron" size={13} /></span>
    <span className="vivic-file-card-preview">{isReadableFile(props.mediaType) ? (props.previewText ?? "").replace(/^#{1,6}\s+|^\[第 \d+ 页\]\s*/gm, "").replace(/\n{2,}/g, "\n").trim() || "点击打开文件" : "此格式仅保留原文件下载"}</span>
  </button><FileDetails card={card} canvasId={canvasId} open={open} onOpenChange={setOpen} /></>;
}
