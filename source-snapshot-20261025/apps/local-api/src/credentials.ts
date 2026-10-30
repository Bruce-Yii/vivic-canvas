/**
 * CredentialStore — StepFun API key lives in process memory ONLY. No disk,
 * no logs, no response payload, no localStorage/IndexedDB (C10/C02).
 */
export interface StepfunCredential {
  apiKey: string;
  models: string[];
  defaultModel: string;
  checkedAt: string;
}

/** Shape safe to serialize to clients — never contains key material. */
export interface ProviderStatus {
  name: "stepfun";
  connected: boolean;
  capabilities: string[];
  models?: string[];
  defaultModel?: string;
  checkedAt?: string;
  lastError?: string;
}

export class CredentialStore {
  #current: StepfunCredential | undefined;
  #lastError: string | undefined;

  set(credential: StepfunCredential): void {
    this.#current = credential;
    this.#lastError = undefined;
  }

  clear(): void {
    this.#current = undefined;
    this.#lastError = undefined;
  }

  /** Only already-redacted diagnostics, never upstream response bodies. */
  recordError(error: string): void {
    this.#lastError = error;
  }

  /** Internal use only (intelligence pipeline). Never serialize. */
  getSecret(): StepfunCredential | undefined {
    return this.#current;
  }

  status(): ProviderStatus {
    const current = this.#current;
    if (!current) {
      return {
        name: "stepfun",
        connected: false,
        capabilities: ["structured", "chat"],
        ...(this.#lastError ? { lastError: this.#lastError } : {}),
      };
    }
    return {
      name: "stepfun",
      connected: true,
      capabilities: ["structured", "chat", ...(["step-3.7-flash", "step-5-preview"].includes(current.defaultModel) ? ["vision"] : [])],
      models: current.models,
      defaultModel: current.defaultModel,
      checkedAt: current.checkedAt,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }
}
