import { lazy, Suspense } from "react";
import { ONLINE_BUILD } from "@/online/mode";
const HostedWorkspace = ONLINE_BUILD ? lazy(() => import("@/hosted/HostedWorkspace").then(module => ({ default: module.HostedWorkspace }))) : null;
const ControlApp = ONLINE_BUILD ? null : lazy(() => import("@/control/ControlApp").then(module => ({ default: module.ControlApp })));
const DisplayApp = ONLINE_BUILD ? null : lazy(() => import("@/display/DisplayApp").then(module => ({ default: module.DisplayApp })));
const MobileConsole = ONLINE_BUILD ? null : lazy(() => import("@/control/mobile/MobileConsole").then(module => ({ default: module.MobileConsole })));
const LauncherApp = import.meta.env.MODE === "online" ? null : lazy(() => import("@/launcher/LauncherApp"));

/**
 * One app, three pages (pathname routing, no router dependency):
 *   /            -> user page: text/voice input; cards the user drags in
 *   /control     -> settings (same owner window as `/`, switched in place)
 *   /display     -> read-only stage; ?canvasId= pins a canvas
 *   /playground  -> dev builds only: Card Playground with sample data
 *   /landing/    -> beta landing (landing/index.html -> src/landing/, separate entry); its signup opens /
 *   (unknown)    -> /
 */
const rawPath = window.location.pathname.replace(/\/+$/, "") || "/";
const isDisplay = rawPath === "/display";
if (isDisplay) document.documentElement.dataset.vivicDisplayWindow = "true";
const isOnlineRemote = ONLINE_BUILD && (rawPath === "/remote" || rawPath === "/remote/index.html");
const isPlayground = import.meta.env.DEV && rawPath === "/playground";
// Production builds drop the playground chunk entirely.
const CardPlayground = import.meta.env.DEV ? lazy(() => import("@/dev/CardPlayground").then(module => ({ default: module.CardPlayground }))) : null;

if (/^\/landing(?:\/|$)/.test(window.location.pathname) && window.location.pathname !== "/landing/") {
  // The landing is its own HTML entry; only /landing/ resolves to it. Any other
  // path under it (/landing, or a pasted link with trailing punctuation) lands there too.
  window.location.replace(`/landing/${window.location.search}${window.location.hash}`);
} else if (rawPath !== "/display" && rawPath !== "/control" && rawPath !== "/mobile" && rawPath !== "/launcher" && rawPath !== "/" && !isPlayground && !isOnlineRemote) {
  window.location.replace(`/${window.location.search}`);
}

function App() {
  // Every online device uses the same server Space; a desktop owner is unnecessary.
  if (ONLINE_BUILD && HostedWorkspace) return <Suspense fallback={<div role="status" aria-label="正在载入 Vivic" />}><HostedWorkspace /></Suspense>;
  if (rawPath === "/launcher" && LauncherApp) return <Suspense fallback={<div role="status" aria-label="正在载入启动器" />}><LauncherApp /></Suspense>;
  if (rawPath === "/mobile" && MobileConsole) return <Suspense fallback={null}><MobileConsole /></Suspense>;
  if (isPlayground && CardPlayground) return <Suspense fallback={null}><CardPlayground /></Suspense>;
  return <Suspense fallback={<div role="status" aria-label="正在载入画布" />}>{isDisplay && DisplayApp ? <DisplayApp /> : ControlApp ? <ControlApp /> : null}</Suspense>;
}

export default App;
