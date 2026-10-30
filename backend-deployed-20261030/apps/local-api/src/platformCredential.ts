/**
 * The user's own model-platform key lives in process memory only.
 * It is never written to disk, logs, or a response payload.
 */
export class PlatformCredentialStore {
  #key: string | undefined;
  #lastError: string | undefined;

  set(apiKey: string): void {
    this.#key = apiKey;
    this.#lastError = undefined;
  }

  clear(): void {
    this.#key = undefined;
    this.#lastError = undefined;
  }

  recordError(error: string): void {
    this.#lastError = error;
  }

  /** Internal use only. Never serialize. */
  getSecret(): string | undefined {
    return this.#key;
  }

  status(): { connected: boolean; lastError?: string } {
    return {
      connected: this.#key !== undefined,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }
}
