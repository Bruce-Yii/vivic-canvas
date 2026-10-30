export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const forbiddenKey = (key: string) => ["__proto__", "prototype", "constructor"].includes(key);
export class PackageError extends Error {
  readonly path: string;
  constructor(path: string, message: string) { super(`${path}: ${message}`); this.path = path; this.name = "PackageError"; }
}
export const fail = (path: string, message: string): never => { throw new PackageError(path, message); };

/** Small strict JSON reader also rejects duplicate properties and prototype-related keys. */
export function parseJson(text: string, path: string): Json {
  let offset = 0, nodes = 0;
  const ws = () => { while (/[ \t\r\n]/.test(text[offset] ?? "") && offset < text.length) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const ch = text[offset++];
      if (ch === "\\") { offset++; continue; }
      if (ch === '"') { try { return JSON.parse(text.slice(start, offset)); } catch { fail(path, "无效 JSON 字符串"); } }
    }
    return fail(path, "JSON 字符串未结束");
  };
  const value = (depth: number): Json => {
    if (++nodes > 30000 || depth > 24) fail(path, "JSON 嵌套/节点数超过限制");
    ws(); const ch = text[offset];
    if (ch === '"') return string();
    if (ch === "{" || ch === "[") {
      const object = ch === "{", result: JsonObject = {}, array: Json[] = [];
      offset++; ws();
      const end = object ? "}" : "]";
      if (text[offset] === end) { offset++; return object ? result : array; }
      while (offset < text.length) {
        if (object) {
          ws(); if (text[offset] !== '"') fail(path, "JSON 对象需要字段名");
          const key = string();
          if (forbiddenKey(key) || Object.hasOwn(result, key)) fail(path, `禁止或重复字段 ${key}`);
          ws(); if (text[offset++] !== ":") fail(path, "JSON 缺少冒号");
          result[key] = value(depth + 1);
        } else array.push(value(depth + 1));
        ws(); const next = text[offset++];
        if (next === end) return object ? result : array;
        if (next !== ",") fail(path, "JSON 缺少逗号");
      }
      return fail(path, "JSON 容器未结束");
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(offset))?.[0];
    if (!token) return fail(path, "无效 JSON 值");
    offset += token.length;
    const parsed: Json = JSON.parse(token);
    if (typeof parsed === "number" && !Number.isFinite(parsed)) fail(path, "数字必须有限");
    return parsed;
  };
  const result = value(0); ws();
  if (offset !== text.length) fail(path, "JSON 尾部存在额外内容");
  return result;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Bound unknown persisted/request JSON before recursive canonicalization, using an explicit stack. */
export function checkJsonBudget(value: unknown, path: string): void {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }]; let nodes = 0, chars = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > 30000 || item.depth > 24) fail(path, "JSON 嵌套/节点数超过限制");
    const v = item.value;
    if (typeof v === "string") chars += v.length;
    else if (Array.isArray(v)) for (const child of v) stack.push({ value: child, depth: item.depth + 1 });
    else if (isObject(v)) {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) fail(path, "需要普通 JSON 对象");
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
        if (forbiddenKey(key) || !Object.hasOwn(descriptor, "value")) fail(path, "禁止的 JSON 字段");
        chars += key.length; stack.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    } else if (v !== null && typeof v !== "boolean" && !(typeof v === "number" && Number.isFinite(v))) fail(path, "需要有限 JSON 值");
    if (chars > 262144 || stack.length > 30000) fail(path, "JSON 大小超过限制");
  }
}
