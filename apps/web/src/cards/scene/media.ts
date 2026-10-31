import { useContext, useEffect, useState } from "react";
import { getMediaBlob, isMediaRef } from "./mediaStore";
import { HostedMediaResolverContext } from "./HostedMediaScope";

export * from "./mediaStore";

// Object URLs are shared per reference while any card shows them.
const cache = new Map<string, { url: Promise<string | undefined>; users: number; resolved?: string }>();

function acquire(ref: string) {
  let entry = cache.get(ref);
  if (!entry) {
    const next: { url: Promise<string | undefined>; users: number; resolved?: string } = { users: 0, url: Promise.resolve(undefined) };
    next.url = getMediaBlob(ref).then(blob => {
      next.resolved = blob ? URL.createObjectURL(blob) : undefined;
      return next.resolved;
    });
    cache.set(ref, next);
    entry = next;
  }
  entry.users += 1;
  return entry;
}

function release(ref: string) {
  const entry = cache.get(ref);
  if (!entry) return;
  entry.users -= 1;
  if (entry.users > 0) return;
  cache.delete(ref);
  void entry.url.then(url => { if (url) URL.revokeObjectURL(url); });
}

export type MediaStatus = "none" | "loading" | "ready" | "missing";

/** Resolve an image reference to something an <img> can show. */
export function useMediaUrl(src: string | undefined): { url?: string; status: MediaStatus } {
  const resolver = useContext(HostedMediaResolverContext);
  const local = isMediaRef(src);
  const remote = src && local ? resolver?.(src) : undefined;
  const [state, setState] = useState<{ ref?: string; url?: string; status: MediaStatus }>({ status: "none" });
  useEffect(() => {
    if (!src || !local) return;
    if (resolver) {
      if (!remote) { setState({ ref: src, status: "missing" }); return; }
      const controller = new AbortController(); let objectUrl: string | undefined;
      void fetch(remote, { credentials: "same-origin", cache: "no-store", signal: controller.signal }).then(async response => {
        if (!response.ok || !["image/jpeg", "image/png", "image/webp"].includes(response.headers.get("content-type")?.split(";")[0] ?? "")) throw new Error("Unavailable image");
        const blob = await response.blob();
        if (blob.size > 10_000_000) throw new Error("Image limit");
        controller.signal.throwIfAborted(); objectUrl = URL.createObjectURL(blob);
        setState({ ref: src, url: objectUrl, status: "ready" });
      }).catch(() => { if (!controller.signal.aborted) setState({ ref: src, status: "missing" }); });
      return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }
    let alive = true;
    const entry = acquire(src);
    void entry.url.then(url => { if (alive) setState({ ref: src, url, status: url ? "ready" : "missing" }); });
    return () => { alive = false; release(src); };
  }, [src, local, remote, resolver]);
  if (!src) return { status: "none" };
  if (!local) return { url: src, status: "ready" };
  return state.ref === src ? { url: state.url, status: state.status } : { status: "loading" };
}
