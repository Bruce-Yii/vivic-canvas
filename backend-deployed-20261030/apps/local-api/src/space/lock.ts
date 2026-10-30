import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Fail closed when another service owns the data directory; recover only a verifiably dead PID. */
export function acquireSpaceLock(dataDir: string): () => void {
  const location = path.join(dataDir, "space.lock"), value = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    let file: number;
    try { file = openSync(location, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let old: string, owner: { pid?: unknown };
      try { old = readFileSync(location, "utf8"); owner = JSON.parse(old) as { pid?: unknown }; }
      catch { throw new Error("Space lock is unreadable; inspect the data directory before restarting."); }
      if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("Space lock is invalid; inspect the data directory before restarting.");
      let dead = false;
      try { process.kill(owner.pid, 0); }
      catch (failure) { dead = (failure as NodeJS.ErrnoException).code === "ESRCH"; }
      if (!dead) throw new Error("Space data directory is already owned by a running process.");
      if (readFileSync(location, "utf8") !== old) throw new Error("Space data directory ownership changed while restarting.");
      unlinkSync(location);
      continue;
    }
    try { writeFileSync(file, value, "utf8"); fsyncSync(file); }
    finally { closeSync(file); }
    let released = false;
    return () => {
      if (released) return;
      if (readFileSync(location, "utf8") !== value) throw new Error("Space data directory ownership changed before closing.");
      unlinkSync(location); released = true;
    };
  }
  throw new Error("Could not acquire Space data directory ownership.");
}
