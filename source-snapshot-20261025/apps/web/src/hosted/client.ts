import { HostedSpaceSnapshotSchema, type HostedSpaceSnapshot, type HostedSpaceSummary, type HostedSpaceCommand, type HostedSpaceCommandRequest, type HostedSpaceCommandResult } from "@vivic/contracts";

export interface HostedSession { authenticated: boolean; user?: { id: string; username: string }; device?: { id: string; name: string } }
export interface HostedDevice { id: string; name: string; createdAt?: string; lastSeenAt?: string; current?: boolean }
export interface HostedTask { id: string; status: "accepted" | "running" | "awaiting_clarification" | "succeeded" | "failed" | "cancelled" | "unknown"; message: string; createdCardIds?: string[]; focusCardId?: string }
export interface HostedTaskResult { task: HostedTask; snapshot?: HostedSpaceSnapshot }
export class HostedApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const root = "/api/space";
const segment = encodeURIComponent;
/** HttpOnly cookies identify the device. No credential is retained by this client. */
export async function hostedRequest<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", signal: signal ?? AbortSignal.timeout(20000),
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  let value: unknown;
  try { value = await response.json(); } catch { throw new HostedApiError(response.status, "invalid_response", "服务未返回有效结果，请查询保存状态。"); }
  const result = value as { ok?: boolean; code?: string; message?: string };
  if (!response.ok || result.ok === false) throw new HostedApiError(response.status, result.code ?? "request_failed", result.message ?? "这次请求没有完成。");
  return value as T;
}
const snapshot = async (result: Promise<HostedSpaceSnapshot>) => HostedSpaceSnapshotSchema.parse(await result);
const taskResult = async (result: Promise<HostedTaskResult>) => { const value = await result; if (value.snapshot) value.snapshot = HostedSpaceSnapshotSchema.parse(value.snapshot); return value; };
const commandResult = async (result: Promise<HostedSpaceCommandResult>) => { const value = await result; value.snapshot = HostedSpaceSnapshotSchema.parse(value.snapshot); return value; };
const spacePath = (spaceId: string) => `${root}/spaces/${segment(spaceId)}`;
export const hostedClient = {
  session: (signal?: AbortSignal) => hostedRequest<HostedSession>(`${root}/session`, undefined, "GET", signal),
  login: (username: string, password: string) => hostedRequest<HostedSession>(`${root}/login`, { username, password, deviceName: deviceName() }),
  register: (invite: string, username: string, password: string) => hostedRequest<HostedSession>(`${root}/register`, { invite, username, password, deviceName: deviceName() }),
  logout: () => hostedRequest(`${root}/logout`, {}),
  spaces: (signal?: AbortSignal) => hostedRequest<{ spaces: HostedSpaceSummary[] }>(`${root}/spaces`, undefined, "GET", signal),
  createSpace: (title: string, requestId: string) => hostedRequest<{ space?: HostedSpaceSummary; snapshot?: HostedSpaceSnapshot }>(`${root}/spaces`, { title, requestId }),
  snapshot: (spaceId: string, signal?: AbortSignal) => snapshot(hostedRequest<HostedSpaceSnapshot>(spacePath(spaceId), undefined, "GET", signal)),
  command: (spaceId: string, requestId: string, expectedVersion: number, command: HostedSpaceCommand) => commandResult(hostedRequest<HostedSpaceCommandResult>(`${spacePath(spaceId)}/commands`, { requestId, expectedVersion, command })),
  commandRequest: (spaceId: string, request: HostedSpaceCommandRequest) => commandResult(hostedRequest<HostedSpaceCommandResult>(`${spacePath(spaceId)}/commands`, request)),
  receipt: (spaceId: string, requestId: string) => commandResult(hostedRequest<HostedSpaceCommandResult>(`${spacePath(spaceId)}/commands/${segment(requestId)}`)),
  task: (spaceId: string, requestId: string, text: string, expectedVersion: number, continuationTaskId?: string) => taskResult(hostedRequest<HostedTaskResult>(`${spacePath(spaceId)}/tasks`, { requestId, text, expectedVersion, ...(continuationTaskId ? { continuationTaskId } : {}) })),
  taskStatus: (spaceId: string, requestId: string) => taskResult(hostedRequest<HostedTaskResult>(`${spacePath(spaceId)}/tasks/${segment(requestId)}`)),
  cancelTask: (spaceId: string, requestId: string) => taskResult(hostedRequest<HostedTaskResult>(`${spacePath(spaceId)}/tasks/${segment(requestId)}/cancel`, {})),
  devices: () => hostedRequest<{ devices: HostedDevice[] }>(`${root}/devices`),
  revokeDevice: (id: string) => hostedRequest(`${root}/devices/${segment(id)}`, undefined, "DELETE"),
  pair: () => hostedRequest<{ code: string; expiresAt: string }>(`${root}/pair`, {}),
  claim: (code: string) => hostedRequest<HostedSession>(`${root}/pair/claim`, { code, deviceName: deviceName() }),
};
const deviceName = () => /Android|iPhone|iPad/i.test(navigator.userAgent) ? "手机浏览器" : "电脑浏览器";
export function errorMessage(error: unknown) { return error instanceof HostedApiError ? error.message : "连接中断，结果尚未确认。请查询原请求状态。"; }
export function isUnknownResult(error: unknown) { return !(error instanceof HostedApiError) || error.status >= 500 || error.code === "invalid_response"; }
