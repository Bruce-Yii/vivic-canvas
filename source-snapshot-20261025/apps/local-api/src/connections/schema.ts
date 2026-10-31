import { ConnectionError } from "./types.js";

/** Deliberately bounded JSON-schema subset. Unsupported contracts fail closed, not silently bypassed. */
export function validateToolArguments(schema: Record<string, unknown>, value: unknown): void {
  const fail = () => { throw new ConnectionError("invalid-tool-arguments", "查询参数与服务要求不符，请检查必填内容和格式。"); };
  const visit = (rule: unknown, item: unknown, depth: number) => {
    if (depth > 12 || !rule || typeof rule !== "object" || Array.isArray(rule)) return fail();
    const s = rule as Record<string, unknown>;
    if (s.$ref || s.$dynamicRef || s.not || s.if || s.patternProperties || s.dependentSchemas) return fail();
    for (const key of ["anyOf", "oneOf", "allOf"]) if (s[key]) {
      if (!Array.isArray(s[key]) || s[key].length > 10) return fail();
      let passed = 0;
      for (const branch of s[key]) { try { visit(branch, item, depth + 1); passed++; } catch { /* nonmatching alternative */ } }
      if (key === "allOf" ? passed !== s[key].length : key === "oneOf" ? passed !== 1 : passed === 0) return fail();
    }
    if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(item)) return fail();
    if (Array.isArray(s.enum) && !s.enum.some(option => JSON.stringify(option) === JSON.stringify(item))) return fail();
    const type = item === null ? "null" : Array.isArray(item) ? "array" : typeof item;
    const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
    if (types.length && !types.includes(type) && !(type === "number" && Number.isSafeInteger(item) && types.includes("integer"))) return fail();
    if (typeof item === "string") {
      if (item.length > 8192 || typeof s.maxLength === "number" && item.length > s.maxLength || typeof s.minLength === "number" && item.length < s.minLength) return fail();
      // Remote regular expressions are not evaluated: they can be pathological.
      if (s.pattern) return fail();
    }
    if (typeof item === "number" && (!Number.isFinite(item) || typeof s.minimum === "number" && item < s.minimum || typeof s.maximum === "number" && item > s.maximum)) return fail();
    if (Array.isArray(item)) {
      if (item.length > 50 || typeof s.maxItems === "number" && item.length > s.maxItems || typeof s.minItems === "number" && item.length < s.minItems) return fail();
      for (const child of item) if (s.items) visit(s.items, child, depth + 1);
    } else if (item && typeof item === "object") {
      const props = s.properties && typeof s.properties === "object" ? s.properties as Record<string, unknown> : {};
      const entries = Object.entries(item);
      if (entries.length > 40 || Array.isArray(s.required) && s.required.some(key => typeof key !== "string" || !Object.hasOwn(item, key))) return fail();
      for (const [key, child] of entries) {
        if (["__proto__", "constructor", "prototype"].includes(key)) return fail();
        if (/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)$/i.test(key)) return fail();
        if (props[key]) visit(props[key], child, depth + 1);
        else if (s.additionalProperties === false) return fail();
        else if (s.additionalProperties && typeof s.additionalProperties === "object") visit(s.additionalProperties, child, depth + 1);
        else if (JSON.stringify(child).length > 8192) return fail();
      }
    }
  };
  visit(schema, value, 0);
}
