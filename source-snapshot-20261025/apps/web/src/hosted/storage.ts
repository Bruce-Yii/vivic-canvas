import { HostedSpaceCommandRequestSchema, type HostedSpaceCommandRequest } from "@vivic/contracts";

/** User drafts and validated business command recovery only; no auth/model keys. */
export function readLocal(key: string) { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } }
export function writeLocal(key: string, value: string) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* Draft stays in this tab when browser storage is full/unavailable. */ } }
export interface PendingRequest { id: string; kind: "command" | "task"; request?: HostedSpaceCommandRequest; conflict?: true; draft?: { key: string; fingerprint: string } }
const credentialFields = new Set(["apikey", "modelkey", "password", "secret", "token", "accesstoken", "refreshtoken", "authorization", "cookie", "credential", "credentials"]);
function containsCredentialField(value: unknown): boolean { return Boolean(value && typeof value === "object" && Object.entries(value).some(([key, child]) => credentialFields.has(key.replace(/[_-]/g, "").toLowerCase()) || containsCredentialField(child))); }
/** Parse then JSON-detach once. The returned object is both the ledger payload
 * and the body sent to the server, unaffected by later editor/object changes. */
export function validatedCommandRequest(raw: unknown): HostedSpaceCommandRequest {
  const parsed = HostedSpaceCommandRequestSchema.parse(raw), request = HostedSpaceCommandRequestSchema.parse(JSON.parse(JSON.stringify(parsed)));
  if (containsCredentialField(request.command)) throw new Error("认证或模型凭据不能保存为待重试业务命令。");
  return request;
}
export function writePending(key: string, pending: PendingRequest[]): boolean {
  try { const value = pending.length ? JSON.stringify(pending) : ""; if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); return (localStorage.getItem(key) ?? "") === value; } catch { return false; }
}
export function readPending(key: string): PendingRequest[] {
  try { const value: unknown = JSON.parse(readLocal(key) || "[]"); if (!Array.isArray(value)) return [];
    return value.filter(entry => Boolean(entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 128 && ["command", "task"].includes(entry.kind))).slice(-20).map(entry => {
      let request: HostedSpaceCommandRequest | undefined;
      if (entry.kind === "command" && entry.request) { try { const parsed = validatedCommandRequest(entry.request); if (parsed.requestId === entry.id) request = parsed; } catch { /* Opaque compatibility: retain the ID, never guess a body. */ } }
      return { id: entry.id, kind: entry.kind, ...(request ? { request, ...(entry.conflict === true ? { conflict: true as const } : {}) } : {}),
        ...(entry.draft && typeof entry.draft.key === "string" && entry.draft.key.startsWith("vivic.hosted.draft.") && typeof entry.draft.fingerprint === "string" ? { draft: { key: entry.draft.key, fingerprint: entry.draft.fingerprint } } : {}) };
    });
  } catch { return []; }
}
export const draftKey = (userId: string, spaceId: string, kind = "chat") => `vivic.hosted.draft.${encodeURIComponent(userId)}.${encodeURIComponent(spaceId)}.${kind}`;
export const pendingKey = (userId: string, spaceId: string) => `vivic.hosted.pending.${encodeURIComponent(userId)}.${encodeURIComponent(spaceId)}`;
/** Async transcription/submit may only replace the exact draft it started with. */
export const draftUnchanged = (startedRevision: number, currentRevision: number) => startedRevision === currentRevision;
export function draftFingerprint(text: string) { let hash = 2166136261; for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619); return `${text.length}:${hash >>> 0}`; }
export function clearSubmittedDraft(request: PendingRequest) { const entry = request.draft; if (entry && entry.key.startsWith("vivic.hosted.draft.") && draftFingerprint(readLocal(entry.key)) === entry.fingerprint) writeLocal(entry.key, ""); }
export function matchesSubmittedCreate(entry: PendingRequest, kind: "note" | "todo" | "reminder", text: string, minutes: string): boolean {
  const command = entry.request?.command;
  if (!entry.draft || draftFingerprint(text) !== entry.draft.fingerprint || !command) return false;
  if (kind === "note") return command.type === "note.create" && command.text === text.trim();
  if (kind === "todo") return command.type === "todo.create" && JSON.stringify(command.items) === JSON.stringify(text.split("\n").map(line => line.trim()).filter(Boolean));
  return command.type === "reminder.create" && command.text === text.trim() && Number.isFinite(Number(minutes)) && Math.round(Number(minutes) * 60) === command.seconds;
}
export function clearRecoveredCreateDraft(entry: PendingRequest): void {
  const key = entry.draft?.key, type = entry.request?.command.type, kind = type === "note.create" ? "note" : type === "todo.create" ? "todo" : type === "reminder.create" ? "reminder" : null;
  if (!key || !key.startsWith("vivic.hosted.draft.") || !kind || !key.endsWith(`.${kind}`)) return;
  if (matchesSubmittedCreate(entry, kind, readLocal(key), readLocal(`${key}.minutes`) || "5")) { writeLocal(key, ""); if (kind === "reminder") writeLocal(`${key}.minutes`, ""); }
}
