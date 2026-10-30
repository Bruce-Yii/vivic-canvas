import { useEffect, useState } from "react";
import type { MobileClient } from "@vivic/mobile-console-prototype/client";
import type { CardSnapshot } from "@vivic/mobile-console-prototype/protocol";
/** A memory-only, user-requested thumbnail. Revocation drops bytes and object URLs. */
export function MobileImages({ card, client, online }: { card: CardSnapshot; client: MobileClient; online: boolean }) {
  const [selected, setSelected] = useState<string | null>(null), [url, setUrl] = useState("");
  const [error, setError] = useState(""), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  const image = card.images?.find(image => image.id === selected);
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = "";
    setUrl(""); setError(""); setLoading(false);
    if (online && image && client.readImage) {
      setLoading(true);
      void client.readImage(card.id, image.id, controller.signal).then(file => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(new Blob([file.bytes], { type: image.mediaType })); setUrl(objectUrl);
      }).catch(value => { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : "图片读取失败"); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [card.id, image?.id, image?.sha256, client, online, retry]);
  return <div className="mobile-card-images" data-mobile-images={card.id}>
    {card.imageNotice && <p className="mobile-card-preview-muted" role="status">{card.imageNotice}</p>}
    {card.images?.map(item => <button type="button" key={item.id} disabled={!online || loading} className="mobile-inline-button"
      onClick={() => { setSelected(item.id); setRetry(value => value + 1); }}>查看{item.alt || "图片"} · {item.width}×{item.height}</button>)}
    {loading && <p role="status">正在读取只读图片预览…</p>}
    {online && url && image && <figure><img src={url} alt={image.alt} width={image.width} height={image.height} style={{ maxWidth: "100%", height: "auto", objectFit: "contain" }} /><figcaption>{image.alt}</figcaption></figure>}
    {error && <p role="alert">{error} <button type="button" disabled={!online} onClick={() => setRetry(value => value + 1)}>重新读取</button></p>}
  </div>;
}
