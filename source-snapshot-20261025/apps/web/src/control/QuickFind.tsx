import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "radix-ui";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ControlHost } from "@/sync/controlHost";
import { ControlDialogContent } from "./ControlDialogContent";
import { HarkIcon } from "@/components/hark/HarkPrimitives";

const QuickFindContent = lazy(() => import("./QuickFindContent"));
export interface FindImeState { composing: boolean; endedAt: number }
export interface FindImeController { get: () => FindImeState; start: () => void; end: () => void }

/** This launcher imports no cmdk or pinyin code until the Control opens it. */
export function QuickFind({ host, compact = false }: { host: ControlHost; compact?: boolean }) {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  return <ScopedQuickFind key={`${snapshot.activeCanvasId}:${snapshot.ownerMode}:${snapshot.ownerId}:${snapshot.ready}`} host={host} canvasId={snapshot.activeCanvasId} compact={compact} />;
}

function ScopedQuickFind({ host, canvasId, compact }: { host: ControlHost; canvasId: string | null; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const ime = useRef<FindImeState>({ composing: false, endedAt: 0 });
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || ime.current.composing || event.keyCode === 229 || event.altKey || event.repeat) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && canvasId) {
        // Leave nested reading/editing surfaces in charge of their focus.
        if (document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') && !open) return;
        event.preventDefault(); setOpen(value => !value);
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [canvasId, open]);
  return <Dialog.Root open={open} onOpenChange={value => { ime.current = { composing: false, endedAt: 0 }; setOpen(value); }}>
    <Dialog.Trigger asChild><Button ref={trigger} variant="outline" className={compact ? "vivic-find-compact" : undefined} aria-label="快速找卡" title="快速找卡（Ctrl / ⌘ K）" disabled={!canvasId} data-vivic-find-cards>
      {compact ? <HarkIcon name="search" size={16} /> : <><Search size={16} aria-hidden />快速找卡 <kbd className="text-xs text-neutral-500">⌘ / Ctrl K</kbd></>}
    </Button></Dialog.Trigger>
    {open && <ControlDialogContent title="快速找卡" description="查找当前画布的卡片，支持中文与拼音。"
      className="vivic-find-dialog" data-vivic-quick-find
      onCloseAutoFocus={event => { event.preventDefault();
        (trigger.current?.isConnected ? trigger.current : document.querySelector<HTMLElement>("[data-vivic-find-cards]"))?.focus({ preventScroll: true });
      }}
      onEscapeKeyDown={event => { if (ime.current.composing || event.isComposing || event.keyCode === 229) event.preventDefault(); }}>
      <Suspense fallback={<p role="status" className="p-6">正在加载…</p>}>
        <QuickFindContent host={host} canvasId={canvasId} onClose={() => { ime.current = { composing: false, endedAt: 0 }; setOpen(false); }}
          ime={{ get: () => ime.current, start: () => { ime.current.composing = true; }, end: () => { ime.current = { composing: false, endedAt: Date.now() }; } }} />
      </Suspense>
    </ControlDialogContent>}
  </Dialog.Root>;
}
