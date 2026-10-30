import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import { ONLINE_BUILD } from "@/online/mode";
import { OnlineWorkspaceSuspended, showOnlineWelcome } from "@/online/OnlineWorkspace";
import { ControlOverlayContext } from "./ControlOverlayContext";
import { ConnectionPanel } from "@/connections/ConnectionPanel";
import "@/components/hark/hark.css";
import "./settings-experience.css";

const groups = [{ id: "connections", label: "连接" }, { id: "preferences", label: "偏好" }, { id: "data", label: "数据" }] as const;
type GroupId = typeof groups[number]["id"];
interface SettingsExperienceProps {
  hidden: boolean;
  onBack(): void;
  notice: ReactNode;
  connections: ReactNode;
  voice: ReactNode;
  appearance: ReactNode;
  notifications: ReactNode;
  data: ReactNode;
  permissions: ReactNode;
  local?: ReactNode;
  mobile?: ReactNode;
}

/** Keep editors mounted; the native modal contains focus and makes the chat inert.
 * Existing Radix menus and confirmations portal into this same top layer. */
export function SettingsExperience(props: SettingsExperienceProps) {
  const [active, setActive] = useState<GroupId>("connections");
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const outsidePress = useRef(false);
  const suspended = useContext(OnlineWorkspaceSuspended);
  const visible = !props.hidden && !suspended;
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (visible && !node.open) node.showModal();
    if (!visible && node.open) node.close();
  }, [visible]);
  useEffect(() => {
    const openHash = () => {
      const id = window.location.hash.replace(/^#settings-/, "");
      if (id === "connections" || id === "local" || id === "mobile") setActive("connections");
      if (id === "preferences" || id === "appearance") setActive("preferences");
      if (id === "data" || id === "workspace" || id === "more") setActive("data");
      if (id === "local" || id === "mobile") {
        const detail = dialog.current?.querySelector<HTMLDetailsElement>('[data-settings-extra="' + id + '"]');
        if (detail) detail.open = true;
      }
    };
    openHash(); window.addEventListener("hashchange", openHash);
    return () => window.removeEventListener("hashchange", openHash);
  }, []);
  const outside = (x: number, y: number) => {
    const box = dialog.current?.getBoundingClientRect();
    return Boolean(box && (x < box.left || x > box.right || y < box.top || y > box.bottom));
  };
  return <dialog ref={dialog} className="vivic-settings vivic-settings-experience vh-hark" data-vivic-settings
    data-vivic-online={ONLINE_BUILD || undefined} aria-labelledby="vivic-settings-title"
    onKeyDown={event => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]')]
        .filter(node => node.tabIndex >= 0 && !node.matches(":disabled") && node.getClientRects().length > 0 && node.checkVisibility());
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onCancel={event => { event.preventDefault(); props.onBack(); }}
    onPointerDown={event => { outsidePress.current = event.target === event.currentTarget && outside(event.clientX, event.clientY); }}
    onPointerUp={event => {
      if (outsidePress.current && event.target === event.currentTarget && outside(event.clientX, event.clientY)) props.onBack();
      outsidePress.current = false;
    }}>
    <ControlOverlayContext.Provider value={overlayHost}>
      <HarkSurface as="div" className="se-shell">
        <header className="se-topbar">
          <h1 id="vivic-settings-title">设置</h1>
          <Button variant="ghost" size="icon" className="se-close" aria-label="关闭设置" data-vivic-open-chat onClick={props.onBack}>
            <HarkIcon name="close" size={18} />
          </Button>
        </header>
        <nav className="se-nav" aria-label="设置分组">
          {groups.map(group => <button key={group.id} type="button" data-settings-nav={group.id}
            aria-current={active === group.id ? "page" : undefined} onClick={() => setActive(group.id)}>{group.label}</button>)}
        </nav>
        <div className="se-scroll" data-settings-scroll>
          {props.notice && <div className="se-notice">{props.notice}</div>}
          <section className="se-group" data-settings-group="connections" hidden={active !== "connections"} aria-label="连接设置">
            {props.connections}
            <ConnectionPanel active={visible && active === "connections"} />
            {!ONLINE_BUILD && <>
              <details className="se-details" data-settings-extra="local"><summary>本地服务<HarkIcon name="chevron-down" /></summary><a className="se-caption" href="/launcher" target="_blank" rel="noopener noreferrer" data-settings-launcher>打开本地服务面板</a>{props.local}</details>
            </>}
            {props.mobile && <details className="se-details" data-settings-extra="mobile"><summary>手机连接<HarkIcon name="chevron-down" /></summary>{props.mobile}</details>}
          </section>
          <section className="se-group" data-settings-group="preferences" hidden={active !== "preferences"} aria-label="偏好设置">
            {props.appearance}{props.voice}
            <details className="se-details"><summary>提醒通知<HarkIcon name="chevron-down" /></summary>{props.notifications}</details>
          </section>
          <section className="se-group" data-settings-group="data" hidden={active !== "data"} aria-label="数据设置">
            {props.data}
            <details className="se-details"><summary>位置权限<HarkIcon name="chevron-down" /></summary>{props.permissions}</details>
            {ONLINE_BUILD && <Button variant="ghost" className="se-help" onClick={showOnlineWelcome}><HarkIcon name="info" />重新查看新手引导</Button>}
          </section>
        </div>
      </HarkSurface>
      <div ref={setOverlayHost} className="se-overlays" />
    </ControlOverlayContext.Provider>
  </dialog>;
}
