import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import { ONLINE_BUILD } from "@/online/mode";
import { OnlineWorkspaceSuspended, showOnlineWelcome } from "@/online/OnlineWorkspace";
import { useDisclosureMotion } from "@/motion/useDisclosureMotion";
import { ControlOverlayContext } from "./ControlOverlayContext";
import "@/components/hark/hark.css";
import "./settings-experience.css";

const groups = [{ id: "connections", label: "连接" }, { id: "devices", label: "设备" }, { id: "preferences", label: "偏好" }, { id: "voice", label: "语音" }, { id: "reminders", label: "提醒" }, { id: "data", label: "数据" }] as const;
type GroupId = typeof groups[number]["id"];
const groupFromHash = (hash: string): GroupId | null => {
  const id = hash.replace(/^#settings-/, "");
  if (id === "connections" || id === "services" || id === "apps") return "connections";
  if (id === "devices" || id === "mobile" || id === "pairing") return "devices";
  if (id === "preferences" || id === "appearance") return "preferences";
  if (id === "voice" || id === "speech" || id === "audio" || id === "microphone") return "voice";
  if (id === "reminders") return "reminders";
  if (id === "data" || id === "workspace" || id === "more") return "data";
  return null;
};
interface SettingsExperienceProps {
  hidden: boolean;
  onBack(): void;
  notice: ReactNode;
  connections: ReactNode;
  services: ReactNode;
  voice: ReactNode;
  appearance: ReactNode;
  notifications: ReactNode;
  reminders: ReactNode;
  data: ReactNode;
  permissions: ReactNode;
  mobile?: ReactNode;
}

/** Keep editors mounted; the native modal contains focus and makes the chat inert.
 * Existing Radix menus and confirmations portal into this same top layer. */
export function SettingsExperience(props: SettingsExperienceProps) {
  useDisclosureMotion();
  const [active, setActive] = useState<GroupId>("connections");
  const activeRef = useRef<GroupId>(active);
  activeRef.current = active;
  const [animatedGroups, setAnimatedGroups] = useState<Set<GroupId>>(() => new Set());
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const outsidePress = useRef(false);
  const suspended = useContext(OnlineWorkspaceSuspended);
  const visible = !props.hidden && !suspended;
  const activateGroup = useCallback((group: GroupId, animate: boolean) => {
    if (activeRef.current === group) return;
    activeRef.current = group;
    setActive(group);
    if (animate) setAnimatedGroups(current => current.has(group) ? current : new Set([...current, group]));
  }, []);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (visible) {
      if (!node.open) node.showModal();
      const frame = requestAnimationFrame(() => node.setAttribute("data-open", ""));
      return () => cancelAnimationFrame(frame);
    }
    node.removeAttribute("data-open");
    if (!node.open) return;
    const timer = window.setTimeout(() => node.close(), 220);
    return () => clearTimeout(timer);
  }, [visible]);
  useEffect(() => {
    const openHash = (animate: boolean) => {
      const id = window.location.hash.replace(/^#settings-/, "");
      const group = groupFromHash(window.location.hash);
      if (group) activateGroup(group, animate);
      if (id === "services") {
        const detail = dialog.current?.querySelector<HTMLDetailsElement>("[data-settings-services]");
        if (detail) {
          detail.open = true;
          requestAnimationFrame(() => detail.scrollIntoView({ block: "nearest" }));
        }
      }
    };
    const onHashChange = () => openHash(visible);
    openHash(false); window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [activateGroup, visible]);
  useEffect(() => {
    if (!visible) return;
    const group = groupFromHash(window.location.hash);
    if (group) activateGroup(group, false);
  }, [visible, activateGroup]);
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
            aria-current={active === group.id ? "page" : undefined} onClick={() => activateGroup(group.id, true)}>{group.label}</button>)}
        </nav>
        <div className="se-scroll" data-settings-scroll>
          {props.notice && <div className="se-notice">{props.notice}</div>}
          <section className="se-group" data-settings-group="connections" data-enter-animation={animatedGroups.has("connections") || undefined} hidden={active !== "connections"} aria-label="连接设置">
            {props.connections}
            <details className="se-details" data-settings-services><summary>应用与生活服务<HarkIcon name="chevron-down" /></summary><div className="se-detail-body">{props.services}</div></details>
          </section>
          <section className="se-group" data-settings-group="devices" data-enter-animation={animatedGroups.has("devices") || undefined} hidden={active !== "devices"} aria-label="设备设置">
            {props.mobile}
          </section>
          <section className="se-group" data-settings-group="preferences" data-enter-animation={animatedGroups.has("preferences") || undefined} hidden={active !== "preferences"} aria-label="偏好设置">
            {props.appearance}
            <details className="se-details"><summary>提醒通知<HarkIcon name="chevron-down" /></summary>{props.notifications}</details>
          </section>
          <section className="se-group" data-settings-group="voice" data-enter-animation={animatedGroups.has("voice") || undefined} hidden={active !== "voice"} aria-label="语音设置">
            {props.voice}
          </section>
          <section className="se-group" data-settings-group="reminders" data-enter-animation={animatedGroups.has("reminders") || undefined} hidden={active !== "reminders"} aria-label="提醒">
            {props.reminders}
          </section>
          <section className="se-group" data-settings-group="data" data-enter-animation={animatedGroups.has("data") || undefined} hidden={active !== "data"} aria-label="数据设置">
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
