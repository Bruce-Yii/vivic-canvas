import { execFile } from "node:child_process";
import { freemem, totalmem } from "node:os";
import type { StartluxProfile, StartluxMemorySnapshot } from "./startluxProfiles.js";

export type ResourceSnapshot = StartluxMemorySnapshot & { basis: "os-available" | "mac-free-inactive-speculative"; sampledAt: number };
export function macAvailableMemory(output: string): number | null {
  const size = /page size of (\d+) bytes/.exec(output);
  const counts = ["Pages free", "Pages inactive", "Pages speculative"].map(label => new RegExp(`${label}:\\s+(\\d+)\\.`).exec(output));
  if (!size || counts.some(value => !value)) return null;
  const bytes = Number(size[1]) * counts.reduce((sum, value) => sum + Number(value![1]), 0);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}
export async function sampleResources(): Promise<ResourceSnapshot> {
  const total = totalmem();
  if (process.platform === "darwin") {
    // Inactive/speculative pages are an estimate of reclaimable cache. Do not
    // add purgeable pages again: those may already belong to the counted lists.
    const raw = await new Promise<string>(resolve => execFile("/usr/bin/vm_stat", [], { timeout: 2000, maxBuffer: 16384, encoding: "utf8" }, (error, out) => resolve(error ? "" : out)));
    const available = macAvailableMemory(raw);
    return { totalMemoryBytes: total, freeMemoryBytes: available === null ? NaN : Math.min(total, available), basis: "mac-free-inactive-speculative", sampledAt: Date.now() };
  }
  return { totalMemoryBytes: total, freeMemoryBytes: freemem(), basis: "os-available", sampledAt: Date.now() };
}
export function resourceBudget(profile: StartluxProfile, snapshot: ResourceSnapshot) {
  const valid = Number.isSafeInteger(snapshot.totalMemoryBytes) && Number.isSafeInteger(snapshot.freeMemoryBytes) && snapshot.freeMemoryBytes >= 0 && snapshot.totalMemoryBytes > 0 && snapshot.freeMemoryBytes <= snapshot.totalMemoryBytes;
  return { ...snapshot, freeMemoryBytes: valid ? snapshot.freeMemoryBytes : null,
    requiredFreeBytes: profile.estimate.freeMemoryGiB * 2 ** 30, requiredTotalBytes: profile.estimate.totalMemoryGiB * 2 ** 30,
    allowed: valid && snapshot.totalMemoryBytes >= profile.estimate.totalMemoryGiB * 2 ** 30 && snapshot.freeMemoryBytes >= profile.estimate.freeMemoryGiB * 2 ** 30 };
}
