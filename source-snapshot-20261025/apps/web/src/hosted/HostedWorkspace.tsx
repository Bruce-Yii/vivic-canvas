import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { type CardRecord, type HostedSpaceCommand, type HostedSpaceCommandRequest, type HostedSpaceSnapshot, type HostedSpaceSummary } from "@vivic/contracts";
import { HarkBackdrop, HarkIcon, HarkSurface, HarkTabs } from "@/components/hark/HarkPrimitives";
import { HostedAssetProvider, useHostedAssets } from "@/hostedAssets/HostedAssets";
import { newId } from "@/lib/id";
import { completedCountdown, reminderVisible } from "@/canvas/reminderPresentation";
import type { CardState } from "@/state/canvasStore";
import { HostedAuth } from "./HostedAuth";
import { HostedDialog } from "./HostedDialog";
import { HostedDefinitions, useRefreshHostedDefinitions } from "./HostedDefinitions";
import { errorMessage, hostedClient, HostedApiError, isUnknownResult, type HostedSession, type HostedTask, type HostedTaskResult } from "./client";
import { clearRecoveredCreateDraft, clearSubmittedDraft, draftFingerprint, draftKey, draftUnchanged, matchesSubmittedCreate, pendingKey, readLocal, readPending, validatedCommandRequest, writeLocal, writePending, type PendingRequest } from "./storage";
import "./hosted.css";

const HostedCardBoard = lazy(() => import("./HostedCardBoard").then(module => ({ default: module.HostedCardBoard })));
const HostedSettings = lazy(() => import("./HostedSettings").then(module => ({ default: module.HostedSettings })));
const HostedVoice = lazy(() => import("./HostedVoice").then(module => ({ default: module.HostedVoice })));
const HostedMigration = lazy(() => import("./HostedMigration").then(module => ({ default: module.HostedMigration })));
const running = (task: HostedTask) => ["accepted", "running", "unknown"].includes(task.status);
const terminal = (task: HostedTask) => !running(task);
const offlineNotice = "暂时离线，草稿仍可编辑。";
const inputFocus = () => document.querySelector<HTMLTextAreaElement>('[aria-label="告诉 Vivic"]')?.focus();
interface Feedback { id: string; task: HostedTask; input?: string }

export function HostedWorkspace() {
  const [session, setSession] = useState<HostedSession | null>(null), [error, setError] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => readLocal("vivic.hosted.theme") === "dark" ? "dark" : "light");
  const refreshSession = useCallback(async () => { const value = await hostedClient.session(); setSession(value); setError(""); return value.authenticated; }, []);
  const logout = useCallback(() => { setSession({ authenticated: false }); setError(""); }, []);
  const changeTheme = useCallback((value: "light" | "dark") => { setTheme(value); writeLocal("vivic.hosted.theme", value); }, []);
  useEffect(() => { const controller = new AbortController(); void hostedClient.session(controller.signal).then(setSession).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); }); return () => controller.abort(); }, []);
  return <div className={`hosted-root vh-hark${theme === "dark" ? " dark" : ""}`} data-theme={theme} data-appearance={theme}>
    <HarkBackdrop theme={theme} />
    {!session ? <main className="hosted-auth"><HarkSurface className="hosted-auth-card"><h1>Vivic</h1><p role="status">{error || "正在连接…"}</p>{error && <button className="hosted-primary" onClick={() => void refreshSession().catch(error => setError(errorMessage(error)))}>重新连接</button>}</HarkSurface></main>
      : !session.authenticated || !session.user ? <HostedAuth onConnected={refreshSession} />
        : <HostedSessionArea key={session.user.id} session={session} theme={theme} onTheme={changeTheme} onLogout={logout} />}
  </div>;
}
function HostedSessionArea({ session, theme, onTheme, onLogout }: { session: HostedSession; theme: "light" | "dark"; onTheme(value: "light" | "dark"): void; onLogout(): void }) {
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
  return snapshot ? <HostedDefinitions key={`${session.user!.id}:${spaceId}`} enabled={snapshot.space.cards.some(card => card.type === "ExtensionCard")}><HostedAssetProvider spaceId={spaceId} onSnapshot={accept}><HostedWorkspaceView key={spaceId} session={session} initialSnapshot={snapshot} spaces={spaces} theme={theme} onTheme={onTheme} onLogout={onLogout} onSnapshot={accept} onChooseSpace={chooseSpace} error={error} /></HostedAssetProvider></HostedDefinitions>
    : <main className="hosted-auth"><HarkSurface className="hosted-auth-card"><h1>你的 Space</h1><p role="status">{error || "正在读取…"}</p>{error && <button className="hosted-primary" onClick={() => void refresh()}>重试</button>}</HarkSurface></main>;
}
function HostedWorkspaceView({ session, initialSnapshot, spaces, theme, onTheme, onLogout, onSnapshot, onChooseSpace, error }: {
  session: HostedSession; initialSnapshot: HostedSpaceSnapshot; spaces: HostedSpaceSummary[]; theme: "light" | "dark"; onTheme(value: "light" | "dark"): void; onLogout(): void; onSnapshot(value: HostedSpaceSnapshot): void; onChooseSpace(id: string): void; error: string;
}) {
  const assets = useHostedAssets(), spaceId = initialSnapshot.space.id, userId = session.user!.id;
  const refreshDefinitions = useRefreshHostedDefinitions();
  const [snapshot, setSnapshot] = useState(initialSnapshot), snapRef = useRef(snapshot);
  const [page, setPage] = useState<"space" | "chat">("space"), [settings, setSettings] = useState(false), [create, setCreate] = useState<"note" | "todo" | "reminder" | null>(null);
  const [voice, setVoice] = useState(false), [inbox, setInbox] = useState(false);
  const [continuation, setContinuation] = useState<string | null>(null);
  const [migration, setMigration] = useState(false);
  const [draft, setDraft] = useState(() => readLocal(draftKey(userId, spaceId))), draftRevision = useRef(0), composing = useRef(false);
  const [pending, setPending] = useState<PendingRequest[]>(() => readPending(pendingKey(userId, spaceId)));
  const [feedback, setFeedback] = useState<Feedback[]>(() => pending.filter(item => item.kind === "task").map(item => ({ id: item.id, task: { id: item.id, status: "unknown", message: "正在查询上次请求的结果…" } })));
  const pendingRef = useRef(pending);
  const [retryableIds, setRetryableIds] = useState<string[]>([]), [recoveredCommand, setRecoveredCommand] = useState<PendingRequest | null>(null);
  const [saving, setSaving] = useState(false), savingRef = useRef(false), [notice, setNotice] = useState("");
  const [offline, setOffline] = useState(false);
  const visibleNotice = [notice, offline ? offlineNotice : ""].filter(Boolean).join(" ");
  const [focusedId, setFocusedId] = useState<string | null>(null), [uploading, setUploading] = useState(false), fileInput = useRef<HTMLInputElement>(null);
  const addMenu = useRef<HTMLDetailsElement>(null);
  const closeAddMenu = useCallback((restoreFocus = false) => { const menu = addMenu.current; if (!menu) return; menu.open = false; if (restoreFocus) menu.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true }); }, []);
  const submission = useRef<{ id: string; revision: number } | null>(null), alive = useRef(true);
  const completedTasks = useRef(new Set<string>());
  const busy = saving || pending.some(item => item.kind === "command" && !item.conflict), taskBusy = pending.some(item => item.kind === "task");
  const retryableCommand = pending.find(item => item.kind === "command" && item.request && !item.conflict && retryableIds.includes(item.id));
  const accept = useCallback((next: HostedSpaceSnapshot) => { if (!alive.current || next.space.id !== spaceId || next.space.version < snapRef.current.space.version || (savingRef.current && next.space.version === snapRef.current.space.version)) return; snapRef.current = next; setSnapshot(next); onSnapshot(next); }, [spaceId, onSnapshot]);
  useEffect(() => { accept(initialSnapshot); }, [initialSnapshot, accept]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const outside = (event: Event) => { const menu = addMenu.current; if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) closeAddMenu(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && addMenu.current?.open) { event.preventDefault(); closeAddMenu(true); } };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("click", outside, true); document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("click", outside, true); document.removeEventListener("keydown", escape, true); };
  }, [closeAddMenu]);
  useEffect(() => { writeLocal(draftKey(userId, spaceId), draft); }, [draft, userId, spaceId]);
  const changePending = useCallback((next: PendingRequest[]) => { pendingRef.current = next; const persisted = writePending(pendingKey(userId, spaceId), next); if (alive.current) setPending(next); return persisted; }, [spaceId, userId]);
  const recordPending = (request: PendingRequest) => !pendingRef.current.some(item => item.id === request.id) && changePending([...pendingRef.current, request]);
  const forgetPending = useCallback((id: string) => { if (alive.current) setRetryableIds(current => current.filter(value => value !== id)); return changePending(pendingRef.current.filter(item => item.id !== id)); }, [changePending]);
  const conflictPending = useCallback((id: string) => { setRetryableIds(current => current.filter(value => value !== id)); changePending(pendingRef.current.map(item => item.id === id ? { ...item, conflict: true as const } : item)); }, [changePending]);
  const receiveCommandReceipt = useCallback((id: string, next: HostedSpaceSnapshot) => {
    const item = pendingRef.current.find(entry => entry.id === id); if (!alive.current || !item) return;
    accept(next); clearRecoveredCreateDraft(item); forgetPending(id); setRecoveredCommand(item); setNotice("原请求已确认保存，当前手改草稿会保留。");
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
      setNotice(result.task.status === "succeeded" ? "已保存" : result.task.message);
    }
  }, [accept, forgetPending, spaceId, userId]);
  const queryPending = useCallback(async (items: PendingRequest[]) => {
    for (const item of items) {
      try { if (item.kind === "command") { const result = await hostedClient.receipt(spaceId, item.id); receiveCommandReceipt(item.id, result.snapshot); }
        else receiveTask(await hostedClient.taskStatus(spaceId, item.id)); }
      catch (error) { const current = pendingRef.current.find(entry => entry.id === item.id); if (!alive.current || !current) continue;
        if (current.kind === "command" && error instanceof HostedApiError && error.status === 404 && error.code === "receipt-not-found") {
          if (current.conflict) setNotice("原请求因冲突未保存，原编号仍可查询；请先核对最新内容。");
          else if (current.request) { setRetryableIds(ids => ids.includes(current.id) ? ids : [...ids, current.id]); setNotice("暂未找到原回执。可继续查询，或明确重试同一份原请求。"); }
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
    savingRef.current = true; setSaving(true); setNotice("正在保存…"); setRecoveredCommand(null);
    if (optimistic) { const next = { ...snapRef.current, space: { ...snapRef.current.space, cards: snapRef.current.space.cards.map(card => card.id === optimistic.id ? optimistic : card) } }; snapRef.current = next; setSnapshot(next); }
    try { const result = await hostedClient.commandRequest(spaceId, request); accept(result.snapshot); forgetPending(requestId); setNotice("已保存"); return true; }
    catch (error) { if (error instanceof HostedApiError && error.status === 409) { if (error.code !== "request-id-conflict") conflictPending(requestId); setNotice("原请求因冲突未保存，草稿和原编号已保留；请先核对最新内容。"); }
      else { if (!isUnknownResult(error) && !(error instanceof HostedApiError && error.status === 401)) forgetPending(requestId); setNotice(errorMessage(error)); }
      if (error instanceof HostedApiError && error.status === 401) onLogout();
      if (!isUnknownResult(error)) void hostedClient.snapshot(spaceId).then(accept).catch(() => {}); return false;
    } finally { savingRef.current = false; if (alive.current) setSaving(false); }
  };
  const retryOriginalCommand = async (id: string) => {
    const item = pendingRef.current.find(entry => entry.id === id && entry.kind === "command");
    if (savingRef.current || !item?.request || item.conflict || !retryableIds.includes(id)) return;
    savingRef.current = true; setSaving(true); setRetryableIds(ids => ids.filter(value => value !== id)); setNotice("正在重试原编号、原内容和原版本…");
    try { const result = await hostedClient.commandRequest(spaceId, item.request); receiveCommandReceipt(id, result.snapshot); }
    catch (error) { if (!alive.current) return;
      if (error instanceof HostedApiError && error.status === 409) { if (error.code !== "request-id-conflict") conflictPending(id); setNotice("原请求因冲突未保存，草稿和原编号已保留；不会自动改版本或新建请求。"); void hostedClient.snapshot(spaceId).then(accept).catch(() => {}); }
      else { setNotice(errorMessage(error)); if (error instanceof HostedApiError && error.status === 401) onLogout(); }
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
    <header className="hosted-header"><label className="hosted-space-select"><HarkIcon name="apps" /><span className="sr-only">选择 Space</span><select value={spaceId} onChange={event => onChooseSpace(event.target.value)}>{spaces.map(space => <option key={space.id} value={space.id}>{space.title}</option>)}</select></label>
      <HarkTabs<"space" | "chat"> label="工作区页面" value={page} tabs={[{ id: "space", label: "Space" }, { id: "chat", label: "聊天" }]} onChange={setPage} />
      <button className="hark-icon-button" aria-label="设置" onClick={() => setSettings(true)}><HarkIcon name="gear" /></button></header>
    <div className="hosted-main"><section className="hosted-space-panel" aria-label={snapshot.space.title} hidden={page !== "space"}>
      <div className="hosted-space-toolbar"><h1>{snapshot.space.title}</h1><div className="hosted-toolbar-actions"><details ref={addMenu} className="hosted-add-menu"><summary className="hark-icon-button" aria-label="新建或上传"><HarkIcon name="add" /></summary><HarkSurface className="hosted-menu"><button onClick={() => { closeAddMenu(true); setRecoveredCommand(null); setCreate("note"); }}><HarkIcon name="file" />便笺</button><button onClick={() => { closeAddMenu(true); setRecoveredCommand(null); setCreate("todo"); }}><HarkIcon name="list" />待办</button><button onClick={() => { closeAddMenu(true); setRecoveredCommand(null); setCreate("reminder"); }}><HarkIcon name="schedule" />提醒</button><button disabled={uploading || busy} onClick={() => { closeAddMenu(true); fileInput.current?.click(); }}><HarkIcon name="attachment" />上传 PDF / MD</button></HarkSurface></details>
        <button className="hark-icon-button" aria-label="整理卡片" disabled={busy} onClick={() => void command({ type: "canvas.arrange" })}><HarkIcon name="apps" /></button><button className="hark-icon-button" aria-label="撤销" disabled={busy} onClick={() => void command({ type: "history.undo" })}><HarkIcon name="back" /></button><button className="hark-icon-button" aria-label="重做" disabled={busy} onClick={() => void command({ type: "history.redo" })}><HarkIcon name="next" /></button></div></div>
      <Suspense fallback={<p className="hosted-panel-loading" role="status">正在载入 Space…</p>}><HostedCardBoard cards={snapshot.space.cards.filter(card => { const entry = { record: card } as CardState; return reminderVisible(entry) || card.id === focusedId && !completedCountdown(entry); })} version={snapshot.space.version} theme={theme} busy={busy} focusedId={focusedId} notice={visibleNotice} unknown={pending.some(item => item.kind === "command") && !saving} onQuery={() => void queryPending(pending.filter(item => item.kind === "command"))} onRetry={retryableCommand && !saving ? () => void retryOriginalCommand(retryableCommand.id) : undefined} onCommand={command} onFocus={setFocusedId} /></Suspense>
    </section><section className="hosted-chat-panel" hidden={page !== "chat"} aria-label="任务反馈"><div className="hosted-chat-scroll"><div className="hosted-chat-column">
      {!feedback.length && <div className="hosted-chat-empty"><h2>有什么想放进 Space？</h2><p className="hosted-muted">结果保存在 Space，聊天里保留进度和卡片引用。</p></div>}
      {feedback.map(item => <div className="hosted-feedback" key={item.id}>{item.input && <HarkSurface className="hosted-message hosted-message-user">{item.input}</HarkSurface>}<HarkSurface className="hosted-message hosted-message-agent"><span className="hosted-task-status" data-status={item.task.status}>{item.task.status === "succeeded" ? "已保存" : item.task.status === "failed" ? "未完成" : item.task.status === "cancelled" ? "已取消" : item.task.status === "unknown" ? "结果待确认" : item.task.status === "awaiting_clarification" ? "需要补充" : "处理中"}</span><p>{item.task.message}</p>
        {item.task.createdCardIds?.map(id => <button className="hosted-card-reference" key={id} onClick={() => focusCard(id)}><HarkIcon name="card" />在 Space 查看<HarkIcon name="next" /></button>)}
        {item.task.focusCardId && <button className="hosted-card-reference" onClick={() => focusCard(item.task.focusCardId!)}><HarkIcon name="card" />打开找到的卡片<HarkIcon name="next" /></button>}
        {item.task.status === "awaiting_clarification" && <button className="hosted-card-reference" onClick={() => { setContinuation(item.id); inputFocus(); }}><HarkIcon name="reply" />补充这个问题</button>}
        {running(item.task) && <div className="hosted-inline-actions"><button className="hosted-quiet" onClick={() => void queryPending([{ id: item.id, kind: "task" }])}>查询状态</button><button className="hosted-quiet" onClick={() => void hostedClient.cancelTask(spaceId, item.id).then(receiveTask).catch(error => setNotice(errorMessage(error)))}>取消任务</button></div>}</HarkSurface></div>)}
    </div></div></section></div>
    <footer className="hosted-footer"><div className="hosted-notices" aria-live="polite">{(visibleNotice || error) && <span>{visibleNotice || error}</span>}{pending.some(item => item.kind === "command") && !saving && <button className="hosted-quiet" onClick={() => void queryPending(pending.filter(item => item.kind === "command"))}>查询保存结果</button>}{retryableCommand && !saving && <button className="hosted-quiet" onClick={() => void retryOriginalCommand(retryableCommand.id)}>重试原请求</button>}
      {snapshot.reminders.length > 0 && <button className="hosted-reminder" onClick={() => setInbox(true)}><HarkIcon name="schedule" />提醒 · {snapshot.reminders.length}</button>}{continuation && <span className="hosted-continuation">正在补充上一个问题<button className="hosted-quiet" onClick={() => setContinuation(null)}>取消</button></span>}{draft.trim().length > 500 && <span className="hosted-error">每次最多 500 字，草稿已保留（{draft.trim().length} 字）。</span>}</div>
      <form className="hosted-composer-form" onSubmit={event => { event.preventDefault(); void submit(); }}><HarkSurface className="hosted-composer"><textarea rows={1} value={draft} aria-label="告诉 Vivic" placeholder="告诉 Vivic…" onChange={event => { draftRevision.current++; setDraft(event.target.value); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); void submit(); } }} /><button className="hark-icon-button hosted-voice-button" type="button" aria-label="语音" onClick={() => setVoice(true)}><HarkIcon name="mic" /></button><button className="hosted-send hark-icon-button" type="submit" aria-label="发送" disabled={!draft.trim() || draft.trim().length > 500 || taskBusy || busy}><HarkIcon name="up" /></button></HarkSurface></form>
    </footer><input ref={fileInput} type="file" accept=".pdf,.md,application/pdf,text/markdown" multiple hidden onChange={event => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; if (!files.length) return; setUploading(true); setNotice("正在上传…"); void assets.upload(files).then(() => setNotice("已保存文件")).catch(error => setNotice(errorMessage(error))).finally(() => setUploading(false)); }} />
    {create && <CreateCard key={create} kind={create} userId={userId} spaceId={spaceId} busy={busy} notice={visibleNotice} unknown={pending.some(item => item.kind === "command") && !saving} onQuery={() => void queryPending(pending.filter(item => item.kind === "command"))} onRetry={retryableCommand && !saving ? () => void retryOriginalCommand(retryableCommand.id) : undefined} recoveredCommand={recoveredCommand} onClose={() => { setCreate(null); setRecoveredCommand(null); }} onCreate={command} />}
    {settings && <Suspense fallback={<div role="status">正在载入设置…</div>}><HostedSettings session={session} snapshot={snapshot} theme={theme} onTheme={onTheme} onClose={() => setSettings(false)} onLogout={onLogout} onImport={() => setMigration(true)} /></Suspense>}
    {voice && <Suspense fallback={<div role="status">正在载入语音…</div>}><HostedVoice onClose={() => setVoice(false)} onInsert={text => { draftRevision.current++; setDraft(current => `${current}${current.trim() ? "\n" : ""}${text}`); }} /></Suspense>}
    {inbox && <HostedDialog title="提醒" onClose={() => setInbox(false)}><div className="hosted-inbox">{snapshot.reminders.map(reminder => <article key={reminder.id}><p>{reminder.text}</p><time className="hosted-muted" dateTime={reminder.firedAt}>{new Date(reminder.firedAt).toLocaleString()}</time></article>)}</div></HostedDialog>}
    {migration && <Suspense fallback={<div role="status">正在读取旧数据…</div>}><HostedMigration spaceId={spaceId} onSnapshot={next => { accept(next); refreshDefinitions(); }} onClose={() => setMigration(false)} /></Suspense>}
  </main>;
}
function CreateCard({ kind, userId, spaceId, busy, notice, unknown, onQuery, onRetry, recoveredCommand, onClose, onCreate }: { kind: "note" | "todo" | "reminder"; userId: string; spaceId: string; busy: boolean; notice: string; unknown: boolean; onQuery(): void; onRetry?(): void; recoveredCommand: PendingRequest | null; onClose(): void; onCreate(command: HostedSpaceCommand): Promise<boolean> }) {
  const key = draftKey(userId, spaceId, kind), minutesKey = `${key}.minutes`, [text, setText] = useState(() => readLocal(key)), [minutes, setMinutes] = useState(() => readLocal(minutesKey) || "5"), [localError, setLocalError] = useState("");
  const revision = useRef(0), recoveredId = useRef<string | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => writeLocal(key, text), [key, text]);
  useEffect(() => { if (kind === "reminder") writeLocal(minutesKey, minutes); }, [kind, minutesKey, minutes]);
  useEffect(() => { if (!recoveredCommand || recoveredId.current === recoveredCommand.id) return; recoveredId.current = recoveredCommand.id;
    if (recoveredCommand.draft?.key === key && matchesSubmittedCreate(recoveredCommand, kind, text, minutes)) { writeLocal(key, ""); if (kind === "reminder") writeLocal(minutesKey, ""); setText(""); onClose(); }
  }, [recoveredCommand, key, kind, text, minutes, minutesKey, onClose]);
  return <HostedDialog title={kind === "note" ? "新建便笺" : kind === "todo" ? "新建待办" : "新建提醒"} onClose={onClose}><form className="hosted-form" onSubmit={event => { event.preventDefault(); if (busy || !text.trim()) return; const started = revision.current; setLocalError("");
    writeLocal(key, text);
    if (kind === "reminder") writeLocal(minutesKey, minutes);
    const command: HostedSpaceCommand = kind === "note" ? { type: "note.create", text: text.trim() } : kind === "todo" ? { type: "todo.create", items: text.split("\n").map(line => line.trim()).filter(Boolean) } : { type: "reminder.create", text: text.trim(), seconds: Math.round(Number(minutes) * 60) };
    if (kind === "todo" && (command.type !== "todo.create" || command.items.length > 30 || command.items.some(item => item.length > 160))) { setLocalError("最多 30 项，每项不超过 160 字。"); return; }
    void onCreate(command).then(ok => { if (alive.current && ok && revision.current === started) { writeLocal(key, ""); if (kind === "reminder") writeLocal(minutesKey, ""); setText(""); onClose(); } });
  }}><label>{kind === "todo" ? "每行一项" : "内容"}<textarea autoFocus value={text} rows={6} maxLength={kind === "note" ? 500 : kind === "reminder" ? 160 : 4800} onChange={event => { revision.current++; writeLocal(key, event.target.value); setText(event.target.value); }} /></label>
    {kind === "reminder" && <label>多少分钟后<input type="number" min={1} max={525600} value={minutes} onChange={event => { revision.current++; writeLocal(minutesKey, event.target.value); setMinutes(event.target.value); }} required /></label>}
    {localError && <p role="alert" className="hosted-error">{localError}</p>}{notice && <p role="status" className="hosted-muted">{notice}</p>}{unknown && <button type="button" className="hosted-quiet" onClick={onQuery}>查询保存结果</button>}{onRetry && <button type="button" className="hosted-quiet" onClick={onRetry}>重试原请求</button>}<button className="hosted-primary" disabled={busy || !text.trim() || (kind === "reminder" && (!Number.isFinite(Number(minutes)) || Number(minutes) < 1))}>保存到 Space</button>
  </form></HostedDialog>;
}
