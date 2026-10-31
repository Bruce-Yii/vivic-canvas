import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Local secret box for provider API keys.
 *
 * Keys must not sit in plaintext on disk and must never reach a log, a
 * response body or a test fixture. They are encrypted with AES-256-GCM using a
 * per-machine key file (mode 0600). This is local-at-rest protection against
 * casual file reads and accidental commits — it is not protection against an
 * attacker who can already read the user's home directory, and it is not a
 * substitute for OS keychain storage.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = "v1:";

export class SecretBox {
  readonly #keyPath: string;
  #key?: Buffer;

  constructor(keyPath: string) {
    this.#keyPath = keyPath;
  }

  #load(): Buffer {
    if (this.#key) return this.#key;
    try {
      if (existsSync(this.#keyPath)) {
        const raw = readFileSync(this.#keyPath);
        if (raw.length === KEY_BYTES) {
          this.#key = raw;
          return raw;
        }
      }
    } catch {
      // Fall through and regenerate; a corrupt key file must not brick startup.
    }
    const key = randomBytes(KEY_BYTES);
    mkdirSync(dirname(this.#keyPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.#keyPath, key, { mode: 0o600 });
    this.#key = key;
    return key;
  }

  encrypt(plaintext: string): string {
    const key = this.#load();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
  }

  /** Returns undefined when the blob is corrupt rather than throwing. */
  decrypt(blob: string | undefined): string | undefined {
    if (!blob) return undefined;
    if (!blob.startsWith(PREFIX)) return undefined;
    try {
      const raw = Buffer.from(blob.slice(PREFIX.length), "base64");
      if (raw.length < IV_BYTES + TAG_BYTES) return undefined;
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", this.#load(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      return undefined;
    }
  }
}

export const defaultSecretKeyPath = (dataDir: string): string => join(dataDir, ".secret-key");
