import { useContext, useState } from "react";
import type { CardViewProps } from "./scene/types";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { FileScopeContext } from "@/files/FileScopeContext";
import { FileDetails } from "@/files/FileDetails";
import "@/files/files.css";
import { OWNER_ONLINE_BUILD } from "@/online/mode";
import { useHostedAssets } from "@/hostedAssets/HostedAssets";
import { fileFormatLabel } from "@/files/filePresentation";

export function FileCardView({ card }: CardViewProps<"FileCard">) {
  return OWNER_ONLINE_BUILD ? <CloudFileCard card={card} /> : <BrowserFileCard card={card} />;
}
function CloudFileCard({ card }: { card: CardViewProps<"FileCard">["card"] }) {
  const assets = useHostedAssets(), props = card.displayProps;
  return <button type="button" className="vivic-file-card-open vivic-file-card-icon nodrag nopan" aria-label={"打开文件：" + props.name} onClick={() => assets.openFile(card)}><span className="vivic-file-mark" aria-hidden="true"><HarkIcon name="file" size={28} /><span>{fileFormatLabel(props.mediaType)}</span></span><span className="vivic-file-card-title">{props.name}</span></button>;
}
function BrowserFileCard({ card }: { card: CardViewProps<"FileCard">["card"] }) {
  const canvasId = useContext(FileScopeContext), [open, setOpen] = useState(false), props = card.displayProps;
  return <><button type="button" className="vivic-file-card-open vivic-file-card-icon nodrag nopan" aria-label={"打开文件：" + props.name} onClick={() => setOpen(true)}>
    <span className="vivic-file-mark" aria-hidden="true"><HarkIcon name="file" size={28} /><span>{fileFormatLabel(props.mediaType)}</span></span>
    <span className="vivic-file-card-title">{props.name}</span>
  </button><FileDetails card={card} canvasId={canvasId} open={open} onOpenChange={setOpen} /></>;
}
