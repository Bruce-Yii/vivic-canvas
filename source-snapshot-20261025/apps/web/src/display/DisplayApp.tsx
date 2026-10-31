import { useEffect, useSyncExternalStore } from "react";
import { DevPanel } from "@/dev/DevPanel";
import { applyUrlTheme } from "@/lib/urlTheme";
import { StageRoot } from "@/stage/StageRoot";
import { canvasStore } from "@/state/canvasStore";
import { getDisplayRuntime, getDisplayStatus, subscribeDisplayStatus, type DisplayRuntime } from "@/sync/browserRuntime";
import { FileScopeContext } from "@/files/FileScopeContext";
import { FullscreenHint } from "./FullscreenHint";
import { useResolvedTheme } from "@/stage/useResolvedTheme";
import "@/components/hark/hark.css";
import "@/control/hark-control.css";

declare global {
  interface Window {
    __vivic?: {
      dispatch: (raw: unknown) => unknown;
      internal: (action: unknown) => unknown;
      getState: () => unknown;
      status?: () => unknown;
    };
  }
}

const params = new URLSearchParams(window.location.search);
const isDevPanel = import.meta.env.DEV && params.get("dev") === "1";
const pinnedCanvasId = params.get("canvasId") ?? undefined;

/**
 * /display — full-window stage with a dismissible browser-fullscreen hint.
 * No persistent nav/settings chrome. ?dev=1 is restricted to development builds.
 */
export const DisplayApp = () => {
  const theme = useResolvedTheme();
  const fileCanvasId = useSyncExternalStore(subscribeDisplayStatus, () => getDisplayStatus()?.canvasId ?? null);
  useEffect(() => {
    let runtime: DisplayRuntime | undefined;
    applyUrlTheme();
    void getDisplayRuntime(pinnedCanvasId).then((r) => {
      runtime = r;
      if (import.meta.env.DEV && window.__vivic) {
        window.__vivic.status = () => r.getStatus();
      }
    });
    if (import.meta.env.DEV) {
      window.__vivic = {
        dispatch: (raw) => canvasStore.dispatch(raw),
        internal: (action) =>
          canvasStore.internal(
            action as Parameters<typeof canvasStore.internal>[0],
          ),
        getState: () => canvasStore.getState(),
        status: () => runtime?.getStatus(),
      };
    }
  }, []);

  return (
    <div className="vh-hark vivic-display-root" data-appearance={theme}>
      <FileScopeContext value={fileCanvasId}><StageRoot /></FileScopeContext>
      <FullscreenHint />
      {isDevPanel && <DevPanel />}
    </div>
  );
};
