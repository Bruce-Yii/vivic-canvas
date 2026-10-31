import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** Browser fullscreen needs a user gesture; the canvas itself always fills its window. */
export function FullscreenHint() {
  const [fullscreen, setFullscreen] = useState(() => Boolean(document.fullscreenElement));
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === "function";

  useEffect(() => {
    const sync = () => { setFullscreen(Boolean(document.fullscreenElement)); setError(null); };
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const enter = async () => {
    if (!supported || busy) return;
    setBusy(true); setError(null);
    try { await document.documentElement.requestFullscreen({ navigationUI: "hide" }); }
    catch { setError("暂时无法隐藏顶部栏，请使用浏览器的全屏功能，或稍后重试。"); }
    finally { setBusy(false); }
  };

  if (fullscreen || dismissed) return null;
  return <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex flex-col items-center gap-2 px-4" data-vivic-fullscreen-hint>
    <div className="pointer-events-auto flex max-w-full items-center gap-1 rounded-full border border-neutral-200 bg-white/90 p-1 shadow-md backdrop-blur-md">
      {supported ? <Button variant="ghost" size="sm" className="rounded-full" disabled={busy} onClick={() => void enter()}>
        <HarkIcon name="expand" className="size-3.5" aria-hidden="true" />{busy ? "正在进入全屏…" : "点击隐藏顶部栏"}
      </Button> : <p className="px-3 text-xs text-neutral-700">可使用浏览器的全屏功能隐藏顶部栏</p>}
      <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={() => setDismissed(true)} aria-label="关闭全屏提示">
        <HarkIcon name="close" className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
    {error && <p className="pointer-events-auto max-w-md rounded-lg bg-white/95 px-3 py-2 text-center text-xs text-neutral-700 shadow-sm"
      role="status" data-vivic-fullscreen-error>{error}</p>}
  </div>;
}
