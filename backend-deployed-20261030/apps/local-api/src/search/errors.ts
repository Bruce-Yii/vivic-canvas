export type SearchErrorCode =
  | "search-invalid-input" | "search-blocked-url" | "search-timeout"
  | "search-unavailable" | "search-rate-limited" | "search-invalid-response"
  | "search-too-large" | "search-unsupported-content" | "search-busy"
  | "search-cancelled" | "search-auth-required";

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  readonly status: 400 | 413 | 415 | 429 | 502 | 503 | 504;
  constructor(code: SearchErrorCode, message: string, status: SearchError["status"]) {
    super(message);
    this.name = "SearchError";
    this.code = code;
    this.status = status;
  }
}

/** Never forward upstream error bodies, URLs, exception messages or stack traces. */
export function publicSearchError(error: unknown): SearchError {
  return error instanceof SearchError ? error
    : new SearchError("search-unavailable", "当前联网查询不可用，请稍后重试。", 502);
}
