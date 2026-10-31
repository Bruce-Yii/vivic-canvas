/** Messages and codes are deliberately public; SQLite and credential errors never cross HTTP. */
export class SpaceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly version?: number;
  constructor(status: number, code: string, message: string, version?: number) {
    super(message);
    this.name = "SpaceError";
    this.status = status;
    this.code = code;
    this.version = version;
  }
}
export function invalid(message = "请求未通过校验。"): never { throw new SpaceError(400, "invalid-request", message); }
