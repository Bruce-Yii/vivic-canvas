import { canonicalJson, fail, forbiddenKey, isObject, type Json, type JsonObject } from "./json";

export interface ValueSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  title?: string; description?: string; default?: Json; enum?: (string | number | boolean)[];
  properties?: Record<string, ValueSchema>; required?: string[]; additionalProperties?: false;
  items?: ValueSchema; minItems?: number; maxItems?: number;
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
}
const keys: Record<ValueSchema["type"], string[]> = {
  object: ["properties", "required", "additionalProperties"], array: ["items", "minItems", "maxItems"],
  string: ["minLength", "maxLength"], number: ["minimum", "maximum"], integer: ["minimum", "maximum"], boolean: [],
};
export function parseValueSchema(raw: unknown, path: string, depth = 0): ValueSchema {
  if (depth > 10 || !isObject(raw) || typeof raw.type !== "string" || !Object.hasOwn(keys, raw.type)) return fail(path, "需要受支持的 Schema type");
  const type = raw.type as ValueSchema["type"];
  const allowed = ["type", "title", "description", "default", "enum", ...keys[type]];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(`${path}/${key}`, "不支持的 Schema 关键字");
  for (const key of ["title", "description"]) if (raw[key] !== undefined && (typeof raw[key] !== "string" || raw[key].length > 400)) fail(`${path}/${key}`, "需要至多 400 字符文本");
  if (raw.enum !== undefined && (!Array.isArray(raw.enum) || !raw.enum.length || raw.enum.length > 50 || raw.enum.some(v => !["string", "number", "boolean"].includes(typeof v)))) fail(`${path}/enum`, "enum 需要 1–50 个基础值");
  if (type === "object") {
    if (raw.additionalProperties !== false || !isObject(raw.properties) || Object.keys(raw.properties).length > 64) fail(path, "object 必须声明 properties 和 additionalProperties:false（至多 64 字段）");
    const properties = raw.properties as Record<string, unknown>;
    for (const [key, child] of Object.entries(properties)) {
      if (forbiddenKey(key) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) fail(`${path}/properties/${key}`, "字段名不合法");
      parseValueSchema(child, `${path}/properties/${key}`, depth + 1);
    }
    if (raw.required !== undefined && (!Array.isArray(raw.required) || new Set(raw.required).size !== raw.required.length || raw.required.some(key => typeof key !== "string" || !Object.hasOwn(properties, key)))) fail(`${path}/required`, "required 必须是已声明且不重复的字段");
  }
  if (type === "array") parseValueSchema(raw.items, `${path}/items`, depth + 1);
  for (const key of ["minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"]) {
    const n = raw[key];
    if (n !== undefined && (typeof n !== "number" || !Number.isFinite(n) || (!key.includes("imum") && (!Number.isInteger(n) || n < 0)))) fail(`${path}/${key}`, "值域限制不合法");
  }
  if (typeof raw.maxItems === "number" && raw.maxItems > 200) fail(path, "maxItems 不能超过 200");
  if (typeof raw.minItems === "number" && raw.minItems > 200) fail(path, "minItems 不能超过 200");
  if (typeof raw.maxLength === "number" && raw.maxLength > 10000) fail(path, "maxLength 不能超过 10000");
  if (typeof raw.minLength === "number" && raw.minLength > 10000) fail(path, "minLength 不能超过 10000");
  for (const [min, max] of [["minimum", "maximum"], ["minItems", "maxItems"], ["minLength", "maxLength"]]) if (typeof raw[min] === "number" && typeof raw[max] === "number" && raw[min] > raw[max]) fail(path, "最小值不能大于最大值");
  const schema = raw as unknown as ValueSchema;
  if (raw.default !== undefined) validateValue(schema, raw.default, `${path}/default`);
  if (schema.enum) {
    if (type === "object" || type === "array") fail(`${path}/enum`, "对象/数组不支持 enum");
    for (const value of schema.enum) validateValue({ ...schema, enum: undefined }, value, `${path}/enum`);
  }
  if (schema.enum && new Set(schema.enum.map(canonicalJson)).size !== schema.enum.length) fail(`${path}/enum`, "枚举值重复");
  return schema;
}
export function validateValue(schema: ValueSchema, value: unknown, path = "value", depth = 0): asserts value is Json {
  if (depth > 14) fail(path, "数据嵌套超过限制");
  if (schema.enum && !schema.enum.some(v => v === value)) fail(path, "值不在 enum 中");
  switch (schema.type) {
    case "object": {
      if (!isObject(value)) return fail(path, "需要对象");
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`${path}/${key}`, "缺少必需字段");
      for (const [key, v] of Object.entries(value)) {
        const child = schema.properties?.[key];
        if (forbiddenKey(key) || !child) return fail(`${path}/${key}`, "未声明字段");
        validateValue(child, v, `${path}/${key}`, depth + 1);
      }
      break;
    }
    case "array":
      if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 200)) return fail(path, "数组长度不合法（最多 200）");
      value.forEach((v, i) => validateValue(schema.items!, v, `${path}/${i}`, depth + 1)); break;
    case "string":
      if (typeof value !== "string" || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 10000)) fail(path, "字符串长度不合法（最多 10000）"); break;
    case "number": case "integer":
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail(path, "数字类型或值域不合法"); break;
    case "boolean": if (typeof value !== "boolean") fail(path, "需要布尔值"); break;
  }
}
export const schemaDefaults = (schema: ValueSchema): Json => {
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.type === "object") return Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([, v]) => v.default !== undefined || v.type === "object").map(([k, v]) => [k, schemaDefaults(v)])) as JsonObject;
  return schema.type === "array" ? [] : schema.enum?.[0] ?? (schema.type === "string" ? "" : schema.type === "boolean" ? false : 0);
};
