import { definitionKey, definitionRef, revalidateDefinition, validateInstance, type CardDefinition, type ExtensionProps } from "@vivic/card-runtime";
import { openVivicDB, type StoredCardDefinition } from "@/persistence/db";
import type { CardRecord } from "@/contracts";

type InstalledDefinition = { definition: CardDefinition; enabled: boolean };
let entries: readonly InstalledDefinition[] = [], error: string | null = null;
let pending: Promise<void> | null = null, revision = 0, loadEpoch = 0, resetEpoch = 0;
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
const emit = () => { revision++; listeners.forEach(fn => fn()); };
const ensureChannel = () => {
  if (!channel && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("vivic:card-definitions:0.1");
    channel.onmessage = () => { void reload(); };
  }
};
async function reload() {
  if (typeof indexedDB === "undefined") return;
  const epoch = ++loadEpoch;
  const db = await openVivicDB();
  try {
    const rows = await db.loadCardDefinitions(), next: InstalledDefinition[] = [];
    let nextError: string | null = null;
    for (const row of rows) {
      try {
        const definition = await revalidateDefinition(row.definition);
        if (definitionKey(definitionRef(definition)) !== row.key) throw new Error("定义 key 与内容身份不匹配");
        next.push({ definition, enabled: row.enabled === true });
      } catch { nextError = "有卡片定义损坏或不兼容；原始定义仍保留，已有实例显示占位。请重新导入。"; }
    }
    if (epoch === loadEpoch) { entries = next; error = nextError; emit(); }
  } finally { db.close(); }
}
const persist = async (record: StoredCardDefinition, active = () => true) => {
  const db = await openVivicDB();
  try { if (!active()) throw new Error("安装会话已失效"); await db.saveCardDefinition(record); } finally { db.close(); }
};
if (typeof document !== "undefined") document.addEventListener("vivic:data-reset", () => { loadEpoch++; resetEpoch++; entries = []; error = null; pending = null; emit(); channel?.postMessage("reload"); });

export const extensionDefinitions = {
  ready(): Promise<void> {
    ensureChannel();
    return pending ??= reload().catch(cause => { error = `卡片定义读取失败：${cause instanceof Error ? cause.message : String(cause)}`; emit(); });
  },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  snapshot: () => revision,
  list: () => entries,
  error: () => error,
  resetMemory() { loadEpoch++; resetEpoch++; entries = []; error = null; pending = null; emit(); },
  refresh: reload,
  get(ref: ExtensionProps["def"], includeDisabled = false) {
    return entries.find(row => definitionKey(definitionRef(row.definition)) === definitionKey(ref) && (includeDisabled || row.enabled))?.definition;
  },
  async install(raw: CardDefinition, expectedHash: string, active = () => true) {
    const definition = await revalidateDefinition(raw);
    if (definition.hash !== expectedHash) throw new Error("包内容发生变化；请重新导入和试跑。");
    await this.ready(); if (!active()) throw new Error("安装会话已失效");
    const ref = definitionRef(definition), key = definitionKey(ref);
    const startedResetEpoch = resetEpoch;
    const conflicting = entries.some(row => row.definition.manifest.id === ref.id && row.definition.manifest.version === ref.version && row.definition.hash !== ref.hash);
    if (conflicting) throw new Error("同 ID/版本存在不同内容；请为新包增加版本号。");
    const row = { definition, enabled: true };
    const previous = entries.find(old => definitionKey(definitionRef(old.definition)) === key);
    // Only publish after the one-record IDB transaction commits. Failure leaves memory unchanged.
    await persist({ key, ...row }, active);
    if (!active()) {
      if (previous && startedResetEpoch === resetEpoch) await persist({ key, ...previous });
      else { const db = await openVivicDB(); try { await db.deleteCardDefinition(key); } finally { db.close(); } }
      loadEpoch++;
      throw new Error("安装会话已取消，定义未安装");
    }
    // A refresh may have read old rows and still be hashing them. Its snapshot must
    // never replace a mutation that has now committed and is published synchronously.
    loadEpoch++;
    entries = [...entries.filter(old => definitionKey(definitionRef(old.definition)) !== key), row]; error = null; emit(); channel?.postMessage("reload");
  },
  async setEnabled(ref: ExtensionProps["def"], enabled: boolean) {
    await this.ready(); const definition = this.get(ref, true); if (!definition) throw new Error("找不到定义");
    const key = definitionKey(ref); await persist({ key, definition, enabled });
    loadEpoch++;
    entries = entries.map(row => definitionKey(definitionRef(row.definition)) === key ? { ...row, enabled } : row); emit(); channel?.postMessage("reload");
  },
  async uninstall(ref: ExtensionProps["def"]) {
    await this.ready(); const key = definitionKey(ref), db = await openVivicDB();
    try { await db.deleteCardDefinition(key); } finally { db.close(); }
    loadEpoch++;
    entries = entries.filter(row => definitionKey(definitionRef(row.definition)) !== key); emit(); channel?.postMessage("reload");
  },
};
export function validateExtensionCard(card: CardRecord): { ok: true } | { ok: false; error: string } {
  if (card.type !== "ExtensionCard") return { ok: true };
  const definition = extensionDefinitions.get(card.displayProps.def);
  if (!definition) return { ok: false, error: "卡片定义缺失或已禁用，请在设置重新导入/启用。" };
  try { validateInstance(definition, card.displayProps); return { ok: true }; }
  catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }; }
}
/** A bounded data-only request; the API repeats content/schema validation. */
export function enabledPlannerDefinitions(): CardDefinition[] {
  let size = 0;
  const latest = new Map<string, CardDefinition>();
  const ordered = entries.filter(row => row.enabled).map(row => row.definition).sort((a, b) => {
    const idOrder = a.manifest.id.localeCompare(b.manifest.id); if (idOrder) return idOrder;
    const av = a.manifest.version.split(".").map(BigInt), bv = b.manifest.version.split(".").map(BigInt);
    for (let i = 0; i < 3; i++) { if (av[i]! > bv[i]!) return -1; if (av[i]! < bv[i]!) return 1; } return 0;
  });
  for (const definition of ordered) if (!latest.has(definition.manifest.id)) latest.set(definition.manifest.id, definition);
  return [...latest.values()].filter(definition => {
    const bytes = new TextEncoder().encode(JSON.stringify(definition)).length;
    if (bytes > 100000 || size + bytes > 400000) return false;
    size += bytes; return true;
  }).slice(0, 8);
}
