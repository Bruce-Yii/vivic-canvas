import { Unzip, UnzipInflate } from "fflate";
import { canonicalJson, checkJsonBudget, fail, isObject, parseJson, type Json, type JsonObject } from "./json";
import { parseValueSchema, validateValue, type ValueSchema } from "./schema";
export * from "./json";
export * from "./schema";

export const PACKAGE_LIMITS = Object.freeze({ compressedBytes: 1_048_576, fileBytes: 262_144, totalBytes: 1_048_576, files: 32 });
export interface CardManifest {
  formatVersion: "0.1" | "0.2"; id: string; version: string; name: string; description: string; renderer: "declarative"; host: "0.6"; capabilities: [];
  /** Routing utterances, distinct from the config/data/state instances in examples/*.json. */
  examples?: string[];
  /** Model parameters for instance.data; callers use dataSchema when absent. */
  slots?: ValueSchema;
  icon?: string;
  category?: string;
}
export type ComponentName = "Header" | "KeyValue" | "Metric" | "List" | "Image" | "Badge" | "Link" | "Table" | "Progress";
export interface UiBlock { component: ComponentName; label?: string; text?: string; bind?: string; columns?: { label: string; field: string }[] }
export interface CardExample { name: string; config: JsonObject; data: JsonObject; state: JsonObject }
export interface CardDefinition {
  manifest: CardManifest; hash: string; configSchema: ValueSchema; dataSchema: ValueSchema; stateSchema: ValueSchema;
  ui: { components: UiBlock[] }; examples: CardExample[];
  /** Only canonical JSON package files are stored, and are revalidated on restart/install. */
  files: Record<string, Json>;
}
export interface ExtensionProps { def: { id: string; version: string; hash: string }; config: JsonObject; data: JsonObject; state: JsonObject }
const components: ComponentName[] = ["Header", "KeyValue", "Metric", "List", "Image", "Badge", "Link", "Table", "Progress"];
const exact = (value: Record<string, unknown>, allowed: string[], path: string) => {
  for (const k of Object.keys(value)) if (!allowed.includes(k)) fail(`${path}/${k}`, "不支持的字段");
};
const textField = (value: unknown, path: string, max: number): string => typeof value === "string" && value.length > 0 && value.length <= max ? value : fail(path, `需要 1–${max} 字符文本`);
export const definitionKey = (ref: { id: string; version: string; hash: string }) => `${ref.id}@${ref.version}#${ref.hash}`;
export const definitionRef = (d: CardDefinition) => ({ id: d.manifest.id, version: d.manifest.version, hash: d.hash });
export function parseManifest(raw: unknown): CardManifest {
  const p = "manifest.json";
  if (!isObject(raw)) return fail(p, "需要对象");
  exact(raw, ["formatVersion", "id", "version", "name", "description", "renderer", "host", "capabilities", "examples", "slots", "icon", "category"], p);
  if (raw.formatVersion !== "0.1" && raw.formatVersion !== "0.2" || raw.renderer !== "declarative" || raw.host !== "0.6") fail(p, "仅支持 formatVersion 0.1 或 0.2 / declarative / host 0.6");
  const id = textField(raw.id, `${p}/id`, 80), version = textField(raw.version, `${p}/version`, 32);
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(id)) fail(`${p}/id`, "使用小写域式 ID，如 example.goal");
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`${p}/version`, "需要 x.y.z 版本");
  if (!Array.isArray(raw.capabilities) || raw.capabilities.length) fail(`${p}/capabilities`, "不支持外部服务、代码或动作能力；capabilities 必须为空");
  let examples: string[] | undefined, slots: ValueSchema | undefined;
  if (raw.examples !== undefined) {
    if (!Array.isArray(raw.examples) || raw.examples.length < 3 || raw.examples.length > 10) fail(`${p}/examples`, "需要 3–10 条触发例句");
    examples = Array.from(raw.examples as unknown[]).map((value, index) => {
      const path = `${p}/examples/${index}`;
      if (typeof value !== "string") return fail(path, "需要 4–40 字符例句");
      const text = value.trim(), length = Array.from(text).length;
      if (length < 4 || length > 40) return fail(path, "需要 4–40 字符例句");
      if (/(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|ftp|file|data|javascript|mailto):|www\.|\/\/[^\s]+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|cn|io|ai|dev|app|edu|gov|co|me|info|xyz|test)\b)/iu.test(text)) return fail(path, "触发例句不能包含 URL");
      return text;
    });
  }
  if (raw.slots !== undefined) {
    checkJsonBudget(raw.slots, `${p}/slots`);
    slots = parseValueSchema(raw.slots, `${p}/slots`);
    if (slots.type !== "object") fail(`${p}/slots`, "参数表根必须是 object，对应实例 data 字段");
  }
  const optionalLabel = (key: "icon" | "category", max: number): string | undefined => {
    if (raw[key] === undefined) return undefined;
    if (typeof raw[key] !== "string" || Array.from(raw[key]).length > max) return fail(`${p}/${key}`, `需要至多 ${max} 字符文本`);
    return raw[key];
  };
  const icon = optionalLabel("icon", 8), category = optionalLabel("category", 20);
  return { formatVersion: raw.formatVersion as CardManifest["formatVersion"], id, version,
    name: textField(raw.name, `${p}/name`, 80), description: textField(raw.description, `${p}/description`, 400),
    renderer: "declarative", host: "0.6", capabilities: [], ...(examples === undefined ? {} : { examples }),
    ...(slots === undefined ? {} : { slots }), ...(icon === undefined ? {} : { icon }), ...(category === undefined ? {} : { category }) };
}
const validPointer = (v: unknown): v is string => typeof v === "string" && v.length <= 256 && /^\/(?:config|data|state)(?:\/(?:[^~\/]|~[01])*)*$/.test(v)
  && v.split("/").every(k => !["__proto__", "constructor", "prototype"].includes(k));
export function parseUi(raw: unknown): CardDefinition["ui"] {
  if (!isObject(raw)) return fail("ui.json", "需要对象");
  exact(raw, ["components"], "ui.json");
  if (!Array.isArray(raw.components) || !raw.components.length || raw.components.length > 30) return fail("ui.json/components", "需要 1–30 个组件");
  const blocks = raw.components.map((item, i): UiBlock => {
    const p = `ui.json/components/${i}`;
    if (!isObject(item) || !components.includes(item.component as ComponentName)) return fail(p, "组件不在受控目录");
    exact(item, ["component", "label", "text", "bind", "columns"], p);
    const component = item.component as ComponentName;
    const label = item.label === undefined ? undefined : textField(item.label, `${p}/label`, 120);
    const text = item.text === undefined ? undefined : textField(item.text, `${p}/text`, 400);
    if (item.bind !== undefined && !validPointer(item.bind)) fail(`${p}/bind`, "仅支持 /config、/data、/state 下 JSON Pointer；禁止表达式");
    if (text === undefined && item.bind === undefined) fail(p, "需要 text 或 bind");
    if (text !== undefined && item.bind !== undefined) fail(p, "text 与 bind 只能选一个");
    let columns: UiBlock["columns"];
    if (item.columns !== undefined) {
      if (component !== "Table" || !Array.isArray(item.columns) || !item.columns.length || item.columns.length > 8) fail(`${p}/columns`, "Table 需要 1–8 列");
      columns = (item.columns as unknown[]).map((column, index) => {
        if (!isObject(column)) return fail(`${p}/columns/${index}`, "列需要对象");
        exact(column, ["label", "field"], `${p}/columns/${index}`);
        const field = textField(column.field, `${p}/columns/${index}/field`, 64);
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(field) || ["constructor", "prototype", "__proto__"].includes(field)) fail(p, "列 field 不合法");
        return { label: textField(column.label, `${p}/columns/${index}/label`, 80), field };
      });
    }
    if (component === "Table" && !columns) fail(p, "Table 必须声明 columns");
    return { component, ...(label ? { label } : {}), ...(text ? { text } : {}), ...(typeof item.bind === "string" ? { bind: item.bind } : {}), ...(columns ? { columns } : {}) };
  });
  return { components: blocks };
}
export function resolvePointer(root: unknown, pointer: string): unknown {
  if (!validPointer(pointer)) return undefined;
  let value = root;
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if ((!isObject(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
export function validateInstance(definition: CardDefinition, props: Pick<ExtensionProps, "config" | "data" | "state">): void {
  validateValue(definition.configSchema, props.config, "config"); validateValue(definition.dataSchema, props.data, "data"); validateValue(definition.stateSchema, props.state, "state");
  if (canonicalJson(props).length > 100000) fail("instance", "实例内容超过 100000 字符");
}
const pathAllowed = (path: string) => /^(?:manifest|config\.schema|data\.schema|state\.schema|ui)\.json$/.test(path) || /^examples\/[a-zA-Z0-9_-]{1,60}\.json$/.test(path);
export async function parsePackageFiles(input: Record<string, string | Uint8Array>): Promise<CardDefinition> {
  const entries = Object.entries(input); if (entries.length > PACKAGE_LIMITS.files) fail("package", "文件数超过 32");
  const files: Record<string, Json> = {}; let total = 0;
  for (const [path, value] of entries) {
    if (!pathAllowed(path)) fail(path, "文件路径不受支持或越界；仅允许协议 JSON 文件");
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    total += bytes.byteLength;
    if (bytes.byteLength > PACKAGE_LIMITS.fileBytes || total > PACKAGE_LIMITS.totalBytes) fail(path, "文件/解压总量超过限制");
    let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail(path, "需要 UTF-8 JSON"); }
    files[path] = parseJson(text, path);
  }
  const manifest = parseManifest(files["manifest.json"]), configSchema = parseValueSchema(files["config.schema.json"], "config.schema.json"),
    dataSchema = parseValueSchema(files["data.schema.json"], "data.schema.json"), stateSchema = parseValueSchema(files["state.schema.json"], "state.schema.json");
  if ([configSchema, dataSchema, stateSchema].some(s => s.type !== "object")) fail("schemas", "config/data/state 根必须是 object");
  const ui = parseUi(files["ui.json"]);
  for (const [index, block] of ui.components.entries()) {
    let schema: ValueSchema | undefined;
    if (block.bind) {
      const [root, ...parts] = block.bind.slice(1).split("/").map(v => v.replace(/~1/g, "/").replace(/~0/g, "~"));
      schema = root === "config" ? configSchema : root === "data" ? dataSchema : stateSchema;
      for (const part of parts) schema = schema?.type === "object" ? schema.properties?.[part] : schema?.type === "array" && /^(?:0|[1-9]\d*)$/.test(part) ? schema.items : undefined;
      if (!schema) fail(`ui.json/components/${index}/bind`, "绑定路径未在 Schema 中声明");
    } else schema = { type: "string" };
    const type = schema!.type, expected = block.component === "List" || block.component === "Table" ? ["array"] : block.component === "Progress" ? ["number", "integer"] : block.component === "Image" || block.component === "Link" ? ["string"] : ["string", "number", "integer", "boolean"];
    if (!expected.includes(type)) fail(`ui.json/components/${index}`, "绑定类型与组件不匹配");
    if (block.component === "Table") for (const column of block.columns ?? []) {
      if (schema!.items?.type !== "object" || !schema!.items.properties?.[column.field]) fail(`ui.json/components/${index}/columns`, "Table 列必须引用数组对象中已声明的字段");
    }
  }
  const examples = Object.entries(files).filter(([p]) => p.startsWith("examples/")).map(([path, v]): CardExample => {
    if (!isObject(v)) return fail(path, "示例需要对象");
    exact(v, ["name", "config", "data", "state"], path);
    validateValue(configSchema, v.config, `${path}/config`); validateValue(dataSchema, v.data, `${path}/data`); validateValue(stateSchema, v.state, `${path}/state`);
    if (!isObject(v.config) || !isObject(v.data) || !isObject(v.state)) return fail(path, "示例字段需要对象");
    return { name: textField(v.name, `${path}/name`, 80), config: v.config as JsonObject, data: v.data as JsonObject, state: v.state as JsonObject };
  });
  if (!examples.length || examples.length > 12) fail("examples", "需要 1–12 个有效示例");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(files)));
  const hash = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("");
  return { manifest, hash, configSchema, dataSchema, stateSchema, ui, examples, files };
}
/** Trust boundary for persisted/request definitions: never trust cached validation flags or parsed fields. */
export async function revalidateDefinition(raw: unknown): Promise<CardDefinition> {
  if (!isObject(raw) || !isObject(raw.files) || typeof raw.hash !== "string") return fail("definition", "缺少包内容与 hash");
  if (!/^[a-f0-9]{64}$/.test(raw.hash) || Object.keys(raw.files).length > PACKAGE_LIMITS.files) fail("definition", "hash 或文件数量不合法");
  const files: Record<string, string> = {};
  for (const [p, v] of Object.entries(raw.files)) {
    if (!pathAllowed(p)) fail(p, "文件路径不受支持或越界");
    checkJsonBudget(v, p); files[p] = canonicalJson(v);
  }
  const checked = await parsePackageFiles(files);
  if (checked.hash !== raw.hash) fail("definition/hash", "包内容已变化；请重新校验和试跑");
  return checked;
}
/** ZIP streaming extraction; aborts before accumulating an over-limit decompressed file. */
export function readPackageZip(bytes: Uint8Array): Promise<CardDefinition> {
  if (bytes.length > PACKAGE_LIMITS.compressedBytes || bytes.length < 22 || bytes[0] !== 80 || bytes[1] !== 75) return Promise.reject(new Error("package: 需要至多 1 MiB 的标准 ZIP .vivicard 包"));
  return new Promise((resolve, reject) => {
    const checksums = new Map<string, number>();
    // Check the central directory before inflating. ZIP64, multidisk/encrypted archives and
    // truncated local-header-only streams are deliberately outside v0.1.
    try {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let end = -1;
      for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
      if (end < 0) fail("package", "ZIP 目录缺失或损坏");
      const count = view.getUint16(end + 10, true), start = view.getUint32(end + 16, true), size = view.getUint32(end + 12, true);
      if (!count || count > 33 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || start + size !== end) fail("package", "不支持 ZIP64/分卷或目录超过限制");
      let at = start, declaredTotal = 0; const seenPaths = new Set<string>();
      for (let n = 0; n < count; n++) {
        if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) fail("package", "ZIP 目录项损坏");
        const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true), compressed = view.getUint32(at + 20, true), original = view.getUint32(at + 24, true), nameLength = view.getUint16(at + 28, true), extraLength = view.getUint16(at + 30, true), commentLength = view.getUint16(at + 32, true), offset = view.getUint32(at + 42, true);
        const unixMode = (view.getUint32(at + 38, true) >>> 16) & 0xf000;
        if (at + 46 + nameLength + extraLength + commentLength > end || flags & 65 || ![0, 8].includes(method) || original > PACKAGE_LIMITS.fileBytes || ![0, 0x8000, 0x4000].includes(unixMode)) fail("package", "加密/符号链接/压缩格式/文件大小不受支持");
        const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at + 46, at + 46 + nameLength));
        if (seenPaths.has(name) || !(pathAllowed(name) || name === "examples/")) fail(name, "ZIP 目录包含重复/越界/不支持路径");
        seenPaths.add(name); declaredTotal += original;
        checksums.set(name, view.getUint32(at + 16, true));
        if (declaredTotal > PACKAGE_LIMITS.totalBytes || offset + 30 > start || view.getUint32(offset, true) !== 0x04034b50) fail(name, "ZIP 大小/本地目录不合法");
        const localLength = view.getUint16(offset + 26, true), localName = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset + 30, offset + 30 + localLength));
        if (offset + 30 + localLength + view.getUint16(offset + 28, true) + compressed > start) fail(name, "ZIP 压缩内容越界");
        if (name !== localName || view.getUint16(offset + 8, true) !== method || view.getUint16(offset + 6, true) !== flags) fail(name, "ZIP 本地与中央目录不匹配");
        at += 46 + nameLength + extraLength + commentLength;
      }
      if (at !== end) fail("package", "ZIP 目录长度不匹配");
    } catch (error) { reject(error); return; }
    const files: Record<string, Uint8Array> = {}, seen = new Set<string>(); let total = 0, failed = false;
    const abort = (e: unknown) => { failed = true; reject(e); };
    const unzip = new Unzip(file => {
      if (failed) return;
      try {
        if (file.name.endsWith("/") && file.name === "examples/") { file.terminate(); return; }
        if (!pathAllowed(file.name) || seen.has(file.name) || seen.size >= PACKAGE_LIMITS.files || file.originalSize !== undefined && file.originalSize > PACKAGE_LIMITS.fileBytes) fail(file.name, "重复/越界/不支持路径或文件大小超过限制");
        seen.add(file.name); const chunks: Uint8Array[] = []; let size = 0;
        file.ondata = (err, chunk, final) => {
          if (failed) { file.terminate(); return; }
          if (err) { abort(err); return; }
          size += chunk.length; total += chunk.length;
          if (size > PACKAGE_LIMITS.fileBytes || total > PACKAGE_LIMITS.totalBytes) { file.terminate(); abort(new Error(`${file.name}: 解压大小超过限制`)); return; }
          chunks.push(chunk);
          if (final) {
            const data = new Uint8Array(size); let offset = 0; for (const part of chunks) { data.set(part, offset); offset += part.length; }
            let crc = 0xffffffff;
            for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
            if (((crc ^ 0xffffffff) >>> 0) !== checksums.get(file.name)) { abort(new Error(`${file.name}: ZIP 校验和不匹配`)); return; }
            files[file.name] = data;
          }
        };
        file.start();
      } catch (error) { file.terminate(); abort(error); }
    });
    unzip.register(UnzipInflate);
    try {
      for (let i = 0; i < bytes.length && !failed; i += 1024) unzip.push(bytes.subarray(i, i + 1024), i + 1024 >= bytes.length);
      if (!failed) { if (Object.keys(files).length !== seen.size) fail("package", "ZIP 文件不完整"); void parsePackageFiles(files).then(resolve, reject); }
    } catch (error) { abort(error); }
  });
}
