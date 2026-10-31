import type { CardRecord, CardType } from "./cardRecord";

export interface CardFieldPolicy { query: readonly string[]; result: readonly string[]; userState: readonly string[] }
/** Paths are rooted in CardRecord. Unlisted old card types retain their current editing behavior. */
export const CARD_FIELD_POLICY: Partial<Record<CardType, CardFieldPolicy>> = {
  FileCard: { query: [], result: ["displayProps", "sourceData", "sources"], userState: [] },
  TravelOffersCard: {
    query: ["displayProps.query"],
    result: ["displayProps.items", "displayProps.fetchedAt", "displayProps.mode", "displayProps.status", "sourceData", "sources"],
    userState: ["displayProps.selectedIds", "displayProps.notes"],
  },
  ExtensionCard: { query: ["displayProps.config"], result: ["displayProps.def", "displayProps.data", "sourceData", "sources"], userState: ["displayProps.state"] },
};
const valueAt = (value: unknown, path: string): unknown => path.split(".").reduce<unknown>((current, key) =>
  current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value);
const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((item, index) => equal(item, right[index]));
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every(key => Object.hasOwn(right, key)
    && equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
};
/** Call after merging a proposed patch, before persistence. Provider authority is an internal host capability. */
export function cardFieldPolicyIssue(before: CardRecord, after: CardRecord, authority: "user" | "provider" = "user"): string | null {
  if (before.type !== after.type) return "不能修改卡片类型。";
  const policy = CARD_FIELD_POLICY[before.type];
  if (!policy || authority === "provider") return null;
  if (policy.result.some(path => !equal(valueAt(before, path), valueAt(after, path)))) return "服务结果为只读，请通过受控查询刷新。";
  if (before.type === "TravelOffersCard" && policy.query.some(path => !equal(valueAt(before, path), valueAt(after, path)))) return "查询条件变更需要重新查询，不能沿用旧结果。";
  return null;
}
