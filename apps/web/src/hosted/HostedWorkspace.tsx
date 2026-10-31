import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { type CardRecord, type HostedSpaceCommand, type HostedSpaceCommandRequest, type HostedSpaceSnapshot, type HostedSpaceSummary, type HostedReminderNotice } from "@vivic/contracts";
import { HarkIcon, HarkSurface, HarkTabs } from "@/components/hark/HarkPrimitives";
import { AtmosphereBackground } from "@/components/atmosphere/AtmosphereBackground";
import { DARK_PALETTE_IDS, LIGHT_PALETTE_IDS, paletteFor, type DarkPaletteId, type LightPaletteId, type PaletteId } from "@/components/atmosphere/palettes";
import { useSystemReducedMotion } from "@/motion/useMotionVisibility";
import SiriOrb from "@/components/smoothui/siri-orb";
import { HostedAssetProvider } from "@/hostedAssets/HostedAssets";
import { newId } from "@/lib/id";
import { completedCountdown, reminderVisible } from "@/canvas/reminderPresentation";
import type { CardState } from "@/state/canvasStore";
import { HostedAuth } from "./HostedAuth";
import { HostedDefinitions, useRefreshHostedDefinitions } from "./HostedDefinitions";
import { errorMessage, hostedClient, HostedApiError, isUnknownResult, type HostedSession, type HostedTask, type HostedTaskResult } from "./client";
import { clearRecoveredCreateDraft, clearSubmittedDraft, draftFingerprint, draftKey, draftUnchanged, pendingKey, readLocal, readPending, validatedCommandRequest, writeLocal, writePending, type PendingRequest } from "./storage";
import "./hosted.css";

const HostedCardBoard = lazy(() => import("./HostedCardBoard").then(module => ({ default: module.HostedCardBoard })));
const HostedSettings = lazy(() => import("./HostedSettings").then(module => ({ default: module.HostedSettings })));
const HostedVoice = lazy(() => import("./HostedVoice").then(module => ({ default: module.HostedVoice })));
const HostedMigration = lazy(() => import("./HostedMigration").then(module => ({ default: module.HostedMigration })));
const running = (task: HostedTask) => ["accepted", "running", "unknown"].includes(task.status);
const terminal = (task: HostedTask) => !running(task);
const quietTaskSuccess = (task: HostedTask) => task.status === "succeeded" && ["已保存", "已完成。", "已完成并保存。"].includes(task.message.trim());
const offlineNotice = "暂时离线，草稿仍可编辑。";
const inputFocus = () => document.querySelector<HTMLTextAreaElement>('[aria-label="告诉 Vivic"]')?.focus();
const storedPalette = <T extends string>(key: string, ids: readonly T[], fallback: T): T => {
  const value = readLocal(key);
  return ids.some(id => id === value) ? value as T : fallback;
};
interface Feedback { id: string; task: HostedTask; input?: string }

export function HostedWorkspace() {
  const [session, setSession] = useState<HostedSession | null>(null), [error, setError] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => readLocal("vivic.hosted.theme") === "dark" ? "dark" : "light");
  const [lightPalette, setLightPalette] = useState<LightPaletteId>(() => storedPalette("vivic.hosted.palette.light", LIGHT_PALETTE_IDS, "milk"));
  const [darkPalette, setDarkPalette] = useState<DarkPaletteId>(() => storedPalette("vivic.hosted.palette.dark", DARK_PALETTE_IDS, "midnight"));
  const reducedMotion = useSystemReducedMotion();
  const palette = paletteFor(theme, { lightPalette, darkPalette });
  const refreshSession = useCallback(async () => { const value = await hostedClient.session(); setSession(value); setError(""); return value.authenticated; }, []);
  const logout = useCallback(() => { setSession({ authenticated: false }); setError(""); }, []);
  const changeTheme = useCallback((value: "light" | "dark") => { setTheme(value); writeLocal("vivic.hosted.theme", value); }, []);
  const changePalette = useCallback((id: PaletteId) => {
    if ((DARK_PALETTE_IDS as readonly string[]).includes(id)) { setDarkPalette(id as DarkPaletteId); writeLocal("vivic.hosted.palette.dark", id); }
    else { setLightPalette(id as LightPaletteId); writeLocal("vivic.hosted.palette.light", id); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void hostedClient.session(controller.signal).then(setSession).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); }); return () => controller.abort(); }, []);
  return <div className={`hosted-root vh-hark${theme === "dark" ? " dark" : ""}`} data-theme={theme} data-appearance={theme}>
    <AtmosphereBackground theme={theme} palette={palette} paused={reducedMotion} className="hosted-atmosphere" layer="background" />
    {!session ? <main className="hosted-auth"><HarkSurface className="hosted-auth-card"><h1>Vivic</h1><p role="status">{error || "正在连接…"}</p>{error && <button className="hosted-primary" onClick={() => void refreshSession().catch(error => setError(errorMessage(error)))}>重新连接</button>}</HarkSurface></main>
      : !session.authenticated || !session.user ? <HostedAuth onConnected={refreshSession} />
        : <HostedSessionArea key={session.user.id} session={session} theme={theme} palette={palette} onTheme={changeTheme} onPalette={changePalette} onLogout={logout} />}
  </div>;
}
function HostedSessionArea({ session, theme, palette, onTheme, onPalette, onLogout }: { session: HostedSession; theme: "light" | "dark"; palette: PaletteId; onTheme(value: "light" | "dark"): void; onPalette(id: PaletteId): void; onLogout(): void }) {
  const [spaces, setSpaces] = useState<HostedSpaceSummary[]>([]), [spaceId, setSpaceId] = useState(""), [snapshot, setSnapshot] = useState<HostedSpaceSnapshot | null>(null), [error, setError] = useState("");
  const activeId = useRef(spaceId), refreshSequence = useRef(0);
  const accept = useCallback((next: HostedSpaceSnapshot) => {
    if (next.space.id !== activeId.current) return;
    setSnapshot(current => current?.space.id === next.space.id && current.space.version > next.space.version ? current : next); setSpaces(next.spaces); setError("");
  }, []);
  const chooseSpace = useCallback((id: string) => { activeId.current = id; setSpaceId(id); setSnapshot(null); }, []);
  useEffect(() => { const controller = new AbortController(); void hostedClient.spaces(controller.signal).then(result => { if (controller.signal.aborted) return; setSpaces(result.spaces); if (!result.spaces.some(space => space.id === activeId.current) && result.spaces[0]) chooseSpace(result.spaces[0].id); }).catch(error => { if (controller.signal.aborted) return; if (error instanceof HostedApiError && error.status === 401) onLogout(); else setError(errorMessage(error)); }); return () => controller.abort(); }, [chooseSpace, onLogout]);
  const refresh = useCallback(async () => {
    if (!spaceId) return; const revision = ++refreshSequence.current;
    try { const value = await hostedClient.snapshot(spaceId); if (revision === refreshSequence.current) accept(value); }
    catch (error) { if (activeId.current !== spaceId) return; if (error instanceof HostedApiError && error.status === 401) onLogout(); else setError(errorMessage(error)); }
  }, [spaceId, accept, onLogout]);
  useEffect(() => { if (spaceId) void refresh(); }, [spaceId, refresh]);
  return snapshot ? <HostedDefinitions key={`${session.user!.id}:${spaceId}`} enabled={snapshot.space.cards.some(card => card.type === "ExtensionCard")}><HostedAssetProvider spaceId={spaceId} onSnapshot={accept}><HostedWorkspaceView key={spaceId} session={session} initialSnapshot={snapshot} spaces={spaces} theme={theme} palette={palette} onTheme={onTheme} onPalette={onPalette} onLogout={onLogout} onSnapshot={accept} onChooseSpace={chooseSpace} error={error} /></HostedAssetProvider></HostedDefinitions>
    : <main className="hosted-auth"><HarkSurface className="hosted-auth-card"><h1>你的 Space</h1><p role="status">{error || "正在读取…"}</p>{error && <button className="hosted-primary" onClick={() => void refresh()}>重试</button>}</HarkSurface></main>;
}
function SpacePicker({ spaces, spaceId, title, onChoose }: { spaces: HostedSpaceSummary[]; spaceId: string; title: string; onChoose(id: string): void }) {
  const [open, setOpen] = useState(false), [mounted, setMounted] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLElement>(null);
  const current = spaces.find(space => space.id === spaceId)?.title ?? title;
  useEffect(() => {
    if (open) { setMounted(true); return; }
    root.current?.removeAttribute("data-open");
    const timer = window.setTimeout(() => setMounted(false), 200);
    return () => window.clearTimeout(timer);
  }, [open]);
  useEffect(() => {
    if (!open || !mounted) return;
    const frame = requestAnimationFrame(() => root.current?.setAttribute("data-open", ""));
    const selected = list.current?.querySelector<HTMLButtonElement>("[aria-selected=true]") ?? list.current?.querySelector<HTMLButtonElement>("button");
    selected?.focus();
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); return; }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
      const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index < 0 ? 0 : Math.min(buttons.length - 1, index + 1)) : (index < 0 ? buttons.length - 1 : Math.max(0, index - 1));
      buttons[next]?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open, mounted]);
  return <div className="hosted-space-select" ref={root}>
    <HarkIcon name="apps" /><button ref={trigger} type="button" className="hosted-space-trigger" aria-haspopup="listbox" aria-expanded={open} aria-controls="hosted-space-list" onClick={() => setOpen(value => !value)}><span>{current}</span><HarkIcon name="down" /></button>
    {mounted && <HarkSurface as="div" id="hosted-space-list" ref={list} className="hosted-menu hosted-space-menu" role="listbox" aria-label="选择 Space">
      {spaces.map(space => <button key={space.id} type="button" role="option" aria-selected={space.id === spaceId} onClick={() => { onChoose(space.id); setOpen(false); trigger.current?.focus(); }}><HarkIcon name={space.id === spaceId ? "check" : "apps"} />{space.title}</button>)}
    </HarkSurface>}
  </div>;
}
function visibleReminders(reminders: HostedReminderNotice[], now = Date.now()) {
  return reminders.filter(reminder => Date.parse(reminder.targetAt) > now);
}
function ReminderPopover({ reminders }: { reminders: HostedReminderNotice[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 15000); return () => window.clearInterval(timer); }, []);
  const current = visibleReminders(reminders, now);
  const [open, setOpen] = useState(false), [mounted, setMounted] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    root.current?.removeAttribute("data-open");
    const timer = window.setTimeout(() => setMounted(false), 220);
    return () => window.clearTimeout(timer);
  }, [open]);
  useEffect(() => {
    if (!open || !mounted) return;
    const frame = requestAnimationFrame(() => root.current?.setAttribute("data-open", ""));
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key !== "Escape") return; event.preventDefault(); setOpen(false); trigger.current?.focus(); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open, mounted]);
  if (!current.length) return null;
  return <div className="hosted-reminder-anchor" ref={root}>
    <button ref={trigger} type="button" className="hosted-reminder" aria-expanded={open} aria-controls="hosted-reminder-list" onClick={() => setOpen(value => !value)}><HarkIcon name="schedule" />提醒 · {current.length}</button>
    {mounted && <HarkSurface as="div" id="hosted-reminder-list" className="hosted-reminder-menu" role="dialog" aria-label="提醒">
      <div className="hosted-inbox">{current.map(reminder => <article key={reminder.id}><p>{reminder.text}</p><time className="hosted-muted" dateTime={reminder.firedAt}>{new Date(reminder.firedAt).toLocaleString()}</time></article>)}</div>
    </HarkSurface>}
  </div>;
}
function HostedWorkspaceView({ session, initialSnapshot, spaces, theme, palette, onTheme, onPalette, onLogout, onSnapshot, onChooseSpace, error }: {
  session: HostedSession; initialSnapshot: HostedSpaceSnapshot; spaces: HostedSpaceSummary[]; theme: "light" | "dark"; palette: PaletteId; onTheme(value: "light" | "dark"): void; onPalette(id: PaletteId): void; onLogout(): void; onSnapshot(value: HostedSpaceSnapshot): void; onChooseSpace(id: string): void; error: string;
}) {
  const refreshDefinitions = useRefreshHostedDefinitions();
  const reduceMotion = useSystemReducedMotion();
  const spaceId = initialSnapshot.space.id, userId = session.user!.id;
  const [snapshot, setSnapshot] = useState(initialSnapshot), snapRef = useRef(snapshot);
  const [page, setPage] = useState<"space" | "chat">("chat"), [settings, setSettings] = useState(false);
  const [voice, setVoice] = useState(false);
  const [continuation, setContinuation] = useState<string | null>(null);
  const [migration, setMigration] = useState(false);
  const [draft, setDraft] = useState(() => readLocal(draftKey(userId, spaceId))), draftRevision = useRef(0), composing = useRef(false);
  const [pending, setPending] = useState<PendingRequest[]>(() => readPending(pendingKey(userId, spaceId)));
  const [feedback, setFeedback] = useState<Feedback[]>(() => pending.filter(item => item.kind === "task").map(item => ({ id: item.id, task: { id: item.id, status: "unknown", message: "正在查询上次请求的结果…" } })));
  const pendingRef = useRef(pending);
  const [saving, setSaving] = useState(false), savingRef = useRef(false), [notice, setNotice] = useState("");
  const [offline, setOffline] = useState(false);
  const recoveryNotice = /原请求|原编号|原回执|查询保存结果/u.test(notice);
  const visibleNotice = [recoveryNotice ? "" : notice, offline ? offlineNotice : ""].filter(Boolean).join(" ");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const submission = useRef<{ id: string; revision: number } | null>(null), alive = useRef(true);
  const completedTasks = useRef(new Set<string>());
  const busy = saving || pending.some(item => item.kind === "command" && !item.conflict), taskBusy = pending.some(item => item.kind === "task");
  const accept = useCallback((next: HostedSpaceSnapshot) => { if (!alive.current || next.space.id !== spaceId || next.space.version < snapRef.current.space.version || (savingRef.current && next.space.version === snapRef.current.space.version)) return; snapRef.current = next; setSnapshot(next); onSnapshot(next); }, [spaceId, onSnapshot]);
  useEffect(() => { accept(initialSnapshot); }, [initialSnapshot, accept]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { writeLocal(draftKey(userId, spaceId), draft); }, [draft, userId, spaceId]);
  const changePending = useCallback((next: PendingRequest[]) => { pendingRef.current = next; const persisted = writePending(pendingKey(userId, spaceId), next); if (alive.current) setPending(next); return persisted; }, [spaceId, userId]);
  const recordPending = (request: PendingRequest) => !pendingRef.current.some(item => item.id === request.id) && changePending([...pendingRef.current, request]);
  const forgetPending = useCallback((id: string) => changePending(pendingRef.current.filter(item => item.id !== id)), [changePending]);
  const conflictPending = useCallback((id: string) => { changePending(pendingRef.current.map(item => item.id === id ? { ...item, conflict: true as const } : item)); }, [changePending]);
  const receiveCommandReceipt = useCallback((id: string, next: HostedSpaceSnapshot) => {
    const item = pendingRef.current.find(entry => entry.id === id); if (!alive.current || !item) return;
    accept(next); clearRecoveredCreateDraft(item); forgetPending(id); setNotice("原请求已确认保存，当前手改草稿会保留。");
  }, [accept, forgetPending]);
  const receiveTask = useCallback((result: HostedTaskResult) => {
    if (!alive.current || (completedTasks.current.has(result.task.id) && running(result.task))) return;
    if (terminal(result.task)) completedTasks.current.add(result.task.id);
    if (result.snapshot) accept(result.snapshot);
    if (result.task.focusCardId) { const id = result.task.focusCardId; setPage("space"); setFocusedId(id); setTimeout(() => { const element = document.getElementById(`hosted-card-${id}`); element?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" }); element?.focus({ preventScroll: true }); }, 50); }
    setFeedback(current => { const found = current.find(item => item.id === result.task.id); return [...current.filter(item => item.id !== result.task.id), { id: result.task.id, input: found?.input, task: result.task }].slice(-30); });
    if (terminal(result.task)) { const request = pendingRef.current.find(item => item.id === result.task.id);
      if (result.task.status === "succeeded") {
        if (request) clearSubmittedDraft(request);
        const sameRevision = submission.current?.id === result.task.id && draftUnchanged(submission.current.revision, draftRevision.current);
        if (sameRevision) { draftRevision.current++; setDraft(""); }
        else if (!submission.current && request?.draft?.key === draftKey(userId, spaceId)) { const fingerprint = request.draft.fingerprint; setDraft(current => draftFingerprint(current) === fingerprint ? "" : current); }
      }
      forgetPending(result.task.id);
      setNotice(result.task.status === "succeeded" ? "" : result.task.message);
    }
  }, [accept, forgetPending, spaceId, userId]);
  const queryPending = useCallback(async (items: PendingRequest[]) => {
    for (const item of items) {
      try { if (item.kind === "command") { const result = await hostedClient.receipt(spaceId, item.id); receiveCommandReceipt(item.id, result.snapshot); }
        else receiveTask(await hostedClient.taskStatus(spaceId, item.id)); }
      catch (error) { const current = pendingRef.current.find(entry => entry.id === item.id); if (!alive.current || !current) continue;
        if (current.kind === "command" && error instanceof HostedApiError && error.status === 404 && error.code === "receipt-not-found") {
          if (current.conflict) setNotice("原请求因冲突未保存，原编号仍可查询；请先核对最新内容。");
          else if (current.request) setNotice("暂未找到原回执。原请求仍保留，可稍后再确认。");
          else setNotice("旧请求未记录原始内容，只能继续查询原编号，不会猜测或重新提交。");
        } else setNotice(errorMessage(error));
      }
    }
  }, [spaceId, receiveCommandReceipt, receiveTask]);
  useEffect(() => { const recovered = readPending(pendingKey(userId, spaceId)); if (recovered.length) void queryPending(recovered); }, [spaceId, userId, queryPending]);
  useEffect(() => {
    let active = true, sequence = 0;
    const refresh = () => {
      if (document.hidden || savingRef.current) return;
      const revision = ++sequence;
      void hostedClient.snapshot(spaceId).then(next => { if (!active || revision !== sequence) return; accept(next); setOffline(false); })
        .catch(error => { if (!active || revision !== sequence) return; if (error instanceof HostedApiError && error.status === 401) onLogout(); else setOffline(true); });
    };
    const timer = setInterval(refresh, 12000); window.addEventListener("focus", refresh); window.addEventListener("online", refresh);
    const visible = () => { if (!document.hidden) refresh(); }; document.addEventListener("visibilitychange", visible);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [spaceId, accept, onLogout]);
  useEffect(() => { if (!taskBusy) return; const timer = setInterval(() => { if (!document.hidden) void queryPending(pending.filter(item => item.kind === "task")); }, 3000); return () => clearInterval(timer); }, [pending, taskBusy, queryPending]);
  const command = async (value: HostedSpaceCommand, optimistic?: CardRecord, expectedVersionOverride?: number) => {
    if (savingRef.current || pendingRef.current.some(item => item.kind === "command" && !item.conflict)) return false;
    let request: HostedSpaceCommandRequest;
    try { request = validatedCommandRequest({ requestId: newId("space"), expectedVersion: expectedVersionOverride ?? snapshot.space.version, command: value }); }
    catch { setNotice("本次修改未通过业务命令校验，尚未提交；草稿已保留。"); return false; }
    const requestId = request.requestId;
    const kind = value.type === "note.create" ? "note" : value.type === "todo.create" ? "todo" : value.type === "reminder.create" ? "reminder" : null;
    const key = kind ? draftKey(userId, spaceId, kind) : "";
    if (!recordPending({ id: requestId, kind: "command", request, ...(key ? { draft: { key, fingerprint: draftFingerprint(readLocal(key)) } } : {}) })) { forgetPending(requestId); setNotice("此浏览器无法保存原请求恢复记录，本次尚未提交；请检查浏览器存储后重试。"); return false; }
    savingRef.current = true; setSaving(true); setNotice("正在保存…");
    if (optimistic) { const next = { ...snapRef.current, space: { ...snapRef.current.space, cards: snapRef.current.space.cards.map(card => card.id === optimistic.id ? optimistic : card) } }; snapRef.current = next; setSnapshot(next); }
    try { const result = await hostedClient.commandRequest(spaceId, request); accept(result.snapshot); forgetPending(requestId); setNotice(""); return true; }
    catch (error) { if (error instanceof HostedApiError && error.status === 409) { if (error.code !== "request-id-conflict") conflictPending(requestId); setNotice("原请求因冲突未保存，草稿和原编号已保留；请先核对最新内容。"); }
      else { if (!isUnknownResult(error) && !(error instanceof HostedApiError && error.status === 401)) forgetPending(requestId); setNotice(errorMessage(error)); }
      if (error instanceof HostedApiError && error.status === 401) onLogout();
      if (!isUnknownResult(error)) void hostedClient.snapshot(spaceId).then(accept).catch(() => {}); return false;
    } finally { savingRef.current = false; if (alive.current) setSaving(false); }
  };
  const submit = async () => {
    const text = draft.trim(); if (!text || text.length > 500 || pendingRef.current.some(item => item.kind === "task" || item.kind === "command" && !item.conflict) || savingRef.current || composing.current) return;
    const continuationTaskId = continuation ?? undefined; setContinuation(null);
    const requestId = newId("task"); submission.current = { id: requestId, revision: draftRevision.current }; recordPending({ id: requestId, kind: "task", draft: { key: draftKey(userId, spaceId), fingerprint: draftFingerprint(draft) } });
    setFeedback(current => [...current, { id: requestId, input: text, task: { id: requestId, status: "accepted" as const, message: "正在等待处理…" } }].slice(-30)); setPage("chat");
    try { receiveTask(await hostedClient.task(spaceId, requestId, text, snapRef.current.space.version, continuationTaskId)); }
    catch (error) { if (!isUnknownResult(error)) { forgetPending(requestId); receiveTask({ task: { id: requestId, status: "failed", message: errorMessage(error) } }); }
      else receiveTask({ task: { id: requestId, status: "unknown", message: "结果尚未确认，请查询原请求。" } }); }
  };
  const focusCard = (id: string) => { setPage("space"); setFocusedId(id); setTimeout(() => { const element = document.getElementById(`hosted-card-${id}`); element?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" }); element?.focus({ preventScroll: true }); }, 50); };
  return <main className="hosted-workspace" data-page={page}>
    <header className="hosted-header"><SpacePicker spaces={spaces} spaceId={spaceId} title={snapshot.space.title} onChoose={onChooseSpace} />
      <HarkTabs<"space" | "chat"> label="工作区页面" value={page} tabs={[{ id: "space", label: "Space" }, { id: "chat", label: "聊天" }]} onChange={setPage} />
      <button className="hark-icon-button" aria-label="设置" onClick={() => setSettings(true)}><HarkIcon name="gear" /></button></header>
    <div className="hosted-main"><section className="hosted-space-panel" aria-label={snapshot.space.title} inert={page !== "space"}>
      <div className="hosted-orb" aria-hidden="true"><SiriOrb size="224px" animationDuration={24} reducedMotion={reduceMotion} /></div>
      <div className="hosted-space-toolbar"><h1>{snapshot.space.title}</h1><div className="hosted-toolbar-actions">
        <button className="hark-icon-button" aria-label="整理卡片" disabled={busy} onClick={() => void command({ type: "canvas.arrange" })}><HarkIcon name="apps" /></button><button className="hark-icon-button" aria-label="撤销" disabled={busy} onClick={() => void command({ type: "history.undo" })}><HarkIcon name="back" /></button><button className="hark-icon-button" aria-label="重做" disabled={busy} onClick={() => void command({ type: "history.redo" })}><HarkIcon name="next" /></button></div></div>
      <Suspense fallback={<p className="hosted-panel-loading" role="status">正在载入 Space…</p>}><HostedCardBoard cards={snapshot.space.cards.filter(card => { const entry = { record: card } as CardState; return reminderVisible(entry) || card.id === focusedId && !completedCountdown(entry); })} version={snapshot.space.version} theme={theme} busy={busy} focusedId={focusedId} notice={visibleNotice} onCommand={command} onFocus={setFocusedId} /></Suspense>
    </section><section className="hosted-chat-panel" inert={page !== "chat"} aria-label="任务反馈"><div className="hosted-chat-scroll"><div className="hosted-chat-column">
      {!feedback.length && <div className="hosted-chat-empty"><h2>有什么想放进 Space？</h2><p className="hosted-muted">结果保存在 Space，聊天里保留进度和卡片引用。</p></div>}
      {feedback.map(item => { const quietSuccess = quietTaskSuccess(item.task), hasReferences = Boolean(item.task.createdCardIds?.length || item.task.focusCardId);
        return <div className="hosted-feedback" key={item.id}>{item.input && <HarkSurface className="hosted-message hosted-message-user">{item.input}</HarkSurface>}
          {(!quietSuccess || hasReferences) && <HarkSurface className="hosted-message hosted-message-agent">
            {item.task.status !== "succeeded" && <span className="hosted-task-status" data-status={item.task.status}>{item.task.status === "failed" ? "未完成" : item.task.status === "cancelled" ? "已取消" : item.task.status === "unknown" ? "结果待确认" : item.task.status === "awaiting_clarification" ? "需要补充" : "处理中"}</span>}
            {!quietSuccess && <p>{item.task.message}</p>}
            {item.task.createdCardIds?.map(id => <button className="hosted-card-reference" key={id} onClick={() => focusCard(id)}><HarkIcon name="card" />在 Space 查看<HarkIcon name="next" /></button>)}
            {item.task.focusCardId && <button className="hosted-card-reference" onClick={() => focusCard(item.task.focusCardId!)}><HarkIcon name="card" />打开找到的卡片<HarkIcon name="next" /></button>}
            {item.task.status === "awaiting_clarification" && <button className="hosted-card-reference" onClick={() => { setContinuation(item.id); inputFocus(); }}><HarkIcon name="reply" />补充这个问题</button>}
            {running(item.task) && <div className="hosted-inline-actions"><button className="hosted-quiet" onClick={() => void queryPending([{ id: item.id, kind: "task" }])}>查询状态</button><button className="hosted-quiet" onClick={() => void hostedClient.cancelTask(spaceId, item.id).then(receiveTask).catch(error => setNotice(errorMessage(error)))}>取消任务</button></div>}
          </HarkSurface>}
        </div>;
      })}
    </div></div></section></div>
    <footer className="hosted-footer"><div className="hosted-notices" aria-live="polite">{(visibleNotice || error) && <span>{visibleNotice || error}</span>}
      {snapshot.reminders.length > 0 && <ReminderPopover reminders={snapshot.reminders} />}{continuation && <span className="hosted-continuation">正在补充上一个问题<button className="hosted-quiet" onClick={() => setContinuation(null)}>取消</button></span>}{draft.trim().length > 500 && <span className="hosted-error">每次最多 500 字，草稿已保留（{draft.trim().length} 字）。</span>}</div>
      <form className="hosted-composer-form" onSubmit={event => { event.preventDefault(); void submit(); }}><HarkSurface className="hosted-composer"><textarea rows={1} value={draft} aria-label="告诉 Vivic" placeholder="告诉 Vivic…" onChange={event => { draftRevision.current++; setDraft(event.target.value); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); void submit(); } }} /><button className="hark-icon-button hosted-voice-button" type="button" aria-label="语音" onClick={() => setVoice(true)}><HarkIcon name="mic" /></button><button className="hosted-send hark-icon-button" type="submit" aria-label="发送" disabled={!draft.trim() || draft.trim().length > 500 || taskBusy || busy}><HarkIcon name="up" /></button></HarkSurface></form>
    </footer>
    {settings && <Suspense fallback={<div role="status">正在载入设置…</div>}><HostedSettings session={session} snapshot={snapshot} theme={theme} palette={palette} onTheme={onTheme} onPalette={onPalette} onClose={() => setSettings(false)} onLogout={onLogout} onImport={() => setMigration(true)} /></Suspense>}
    {voice && <Suspense fallback={<div role="status">正在载入语音…</div>}><HostedVoice onClose={() => setVoice(false)} onInsert={text => { draftRevision.current++; setDraft(current => `${current}${current.trim() ? "\n" : ""}${text}`); }} /></Suspense>}
    {migration && <Suspense fallback={<div role="status">正在读取旧数据…</div>}><HostedMigration spaceId={spaceId} onSnapshot={next => { accept(next); refreshDefinitions(); }} onClose={() => setMigration(false)} /></Suspense>}
  </main>;
}
