import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { PACKAGE_LIMITS, parseManifest, parsePackageFiles, readPackageZip, revalidateDefinition, validateInstance,
  validateValue, type Json, type ValueSchema } from "@vivic/card-runtime";

const triggers = ["记录本周阅读目标", "帮我跟踪项目进度", "为学习计划建张卡"];
const objectSchema = (properties: Record<string, ValueSchema> = {}): ValueSchema => ({ type: "object", additionalProperties: false, properties });
const targetSchema: ValueSchema = { ...objectSchema({ target: { type: "number", minimum: 1, maximum: 1000 } }), required: ["target"] };
const legacyManifest = () => ({ formatVersion: "0.1", id: "test.personal-progress", version: "1.0.0", name: "测试进度卡",
  description: "只记录用户提供的进度，不执行代码或请求服务。", renderer: "declarative", host: "0.6", capabilities: [] });
const manifest = (overrides: Record<string, unknown> = {}) => ({ ...legacyManifest(), formatVersion: "0.2", examples: [...triggers],
  slots: structuredClone(targetSchema), icon: "🎯", category: "个人计划", ...overrides });
function files(rawManifest: unknown = manifest()): Record<string, string> {
  return Object.fromEntries(Object.entries({
    "manifest.json": rawManifest,
    "config.schema.json": objectSchema(), "data.schema.json": targetSchema, "state.schema.json": objectSchema(),
    "ui.json": { components: [{ component: "Metric", label: "目标", bind: "/data/target" }] },
    "examples/default.json": { name: "TEST 实例样例", config: {}, data: { target: 12 }, state: {} },
  }).map(([path, value]) => [path, JSON.stringify(value)]));
}
const zip = (input = files(), level: 0 | 6 = 0) => zipSync(Object.fromEntries(Object.entries(input).map(([path, value]) => [path, strToU8(value)])), { level });

describe("additive manifest v0.2 fields", () => {
  it("keeps a minimal v0.1 manifest unchanged and accepts v0.2 without optional fields", () => {
    const old = legacyManifest(); expect(parseManifest(old)).toEqual(old);
    expect(parseManifest({ ...old, formatVersion: "0.2" })).toEqual({ ...old, formatVersion: "0.2" });
  });

  it("parses optional triggers, object slots, icon and category", () => {
    const parsed = parseManifest(manifest());
    expect(parsed).toEqual(manifest());
    expect(parsed.examples).toEqual(triggers);
    expect(() => validateValue(parsed.slots!, { target: 12 })).not.toThrow();
    expect(() => validateValue(parsed.slots!, { target: "12" })).toThrow();
  });

  it("uses Unicode characters for new text limits and rejects whitespace-padded empty triggers", () => {
    expect(parseManifest(manifest({ examples: ["🌱".repeat(4), "📖".repeat(40), "阅读目标四字"], icon: "🎯".repeat(8), category: "读".repeat(20) })).icon).toBe("🎯".repeat(8));
    expect(() => parseManifest(manifest({ examples: ["     ", ...triggers.slice(1)] }))).toThrow("examples/0");
    expect(() => parseManifest(manifest({ examples: new Array(3) }))).toThrow("examples/0");
  });

  it.each([
    undefined, "0.0", "0.3", 0.2,
  ])("rejects unsupported formatVersion %j", formatVersion => {
    expect(() => parseManifest(manifest({ formatVersion }))).toThrow("manifest.json");
  });

  it.each([
    [], triggers.slice(0, 2), Array(11).fill("记录我的目标"), ["短句", ...triggers.slice(1)], ["长".repeat(41), ...triggers.slice(1)],
    [1234, ...triggers.slice(1)], [{ text: "记录目标" }, ...triggers.slice(1)], "记录我的目标", null,
  ])("rejects invalid manifest trigger examples %j", examples => {
    expect(() => parseManifest(manifest({ examples }))).toThrow("manifest.json/examples");
  });

  it.each([
    "打开 https://example.com", "访问HTTP://example.com", "打开ftp://example.com", "访问www.example.com", "保存example.com",
    "打开//example.test/page", "读取file:///tmp/data", "打开javascript:alert(1)", "读取data:text/plain,hi", "邮件mailto:test@example.com",
  ])("rejects a URL-bearing trigger: %s", example => {
    expect(() => parseManifest(manifest({ examples: [example, ...triggers.slice(1)] }))).toThrow("examples/0");
  });

  it.each([
    ["icon", "🎯".repeat(9)], ["icon", 1], ["icon", null], ["category", "类".repeat(21)], ["category", []],
  ])("rejects an invalid %s label %j", (key, value) => {
    expect(() => parseManifest(manifest({ [key as string]: value }))).toThrow(`manifest.json/${key}`);
  });
});

describe("v0.2 slots stay inside the controlled data Schema subset", () => {
  it.each([
    { type: "string" }, { type: "array", items: { type: "string" } }, { type: "boolean" },
    { type: "object", properties: {} }, { type: "object", properties: {}, additionalProperties: true },
    { ...objectSchema(), $ref: "https://example.test/schema" }, { ...objectSchema(), oneOf: [] },
    { ...objectSchema(), properties: { target: { type: "number", execute: "run()" } } },
    { ...objectSchema(), properties: { target: { type: "integer", default: "not-a-number" } } },
    { ...objectSchema(), required: ["undeclared"] },
    JSON.parse('{"type":"object","additionalProperties":false,"properties":{"__proto__":{"type":"string"}}}'),
  ])("rejects unsupported or injected slots %j", slots => {
    expect(() => parseManifest(manifest({ slots }))).toThrow("manifest.json/slots");
  });

  it("rejects functions, accessors and excessive schema nesting without invoking injected code", () => {
    const getter = { calls: 0 }, schema = objectSchema();
    Object.defineProperty(schema, "description", { enumerable: true, get: () => { getter.calls++; return "TEST injected getter"; } });
    expect(() => parseManifest(manifest({ slots: schema }))).toThrow("manifest.json/slots");
    expect(getter.calls).toBe(0);
    expect(() => parseManifest(manifest({ slots: { ...objectSchema(), default: { run: () => "TEST" } } }))).toThrow("manifest.json/slots");
    let nested = objectSchema(); for (let i = 0; i < 12; i++) nested = objectSchema({ child: nested });
    expect(() => parseManifest(manifest({ slots: nested }))).toThrow("manifest.json/slots");
  });

  it.each(["0.1", "0.2"])("keeps capabilities empty for format %s", formatVersion => {
    for (const capabilities of [["network"], ["javascript"], ["service.call"], ["card.delete"], {}, null, undefined]) {
      expect(() => parseManifest(manifest({ formatVersion, capabilities }))).toThrow("capabilities");
    }
  });

  it.each(["script", "endpoint", "tools", "actions", "onClick"])("rejects undeclared manifest capability field %s", field => {
    expect(() => parseManifest(manifest({ [field]: "TEST executable request" }))).toThrow(`manifest.json/${field}`);
  });

  it("does not enable a JavaScript renderer, another host, or executable UI components", async () => {
    expect(() => parseManifest(manifest({ renderer: "javascript" }))).toThrow();
    expect(() => parseManifest(manifest({ host: "0.7" }))).toThrow();
    const input = files(); input["ui.json"] = JSON.stringify({ components: [{ component: "Script", text: "run()" }] });
    await expect(parsePackageFiles(input)).rejects.toThrow("ui.json");
  });
});

describe("old and new packages retain instance validation and exact hash identity", () => {
  it("loads and revalidates the shipped v0.1 package without synthesizing new manifest fields", async () => {
    const paths = ["manifest.json", "config.schema.json", "data.schema.json", "state.schema.json", "ui.json", "examples/default.json"];
    const input = Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(new URL(`../../../examples/card-packages/goal-progress/${path}`, import.meta.url), "utf8")])));
    const old = await parsePackageFiles(input);
    expect(old.manifest.formatVersion).toBe("0.1"); expect(old.manifest).not.toHaveProperty("slots"); expect(old.manifest).not.toHaveProperty("examples");
    expect(old.manifest.slots ?? old.dataSchema).toEqual(old.dataSchema);
    for (const example of old.examples) expect(() => validateInstance(old, example)).not.toThrow();
    expect(await revalidateDefinition(old)).toEqual(old);
    expect((await readPackageZip(zip(input))).hash).toBe(old.hash);
  });

  it("keeps manifest utterances separate from examples/*.json instance examples", async () => {
    const def = await parsePackageFiles(files());
    expect(def.manifest.examples).toEqual(triggers);
    expect(def.examples).toEqual([{ name: "TEST 实例样例", config: {}, data: { target: 12 }, state: {} }]);
    expect(def.manifest.slots ?? def.dataSchema).toEqual(targetSchema);
    expect(() => validateInstance(def, { config: {}, data: { target: 0 }, state: {} })).toThrow("data/target");
    const withoutInstance = files(); delete withoutInstance["examples/default.json"];
    await expect(parsePackageFiles(withoutInstance)).rejects.toThrow("examples");
    const wrongInstance = files(); wrongInstance["examples/default.json"] = JSON.stringify(triggers);
    await expect(parsePackageFiles(wrongInstance)).rejects.toThrow("examples/default.json");
  });

  it.each([
    ["examples", ["记录新的阅读目标", ...triggers.slice(1)]],
    ["slots", { ...objectSchema({ target: { type: "number", minimum: 2, maximum: 1000 } }), required: ["target"] }],
    ["icon", "📖"], ["category", "学习"], ["formatVersion", "0.1"],
  ])("includes manifest %s in the package hash and detects changed persisted files", async (field, value) => {
    const original = await parsePackageFiles(files());
    const modified = await parsePackageFiles(files(manifest({ [field as string]: value })));
    expect(modified.hash).not.toBe(original.hash);
    const tampered = structuredClone(original);
    (tampered.files["manifest.json"] as Record<string, Json>)[field as string] = value as Json;
    await expect(revalidateDefinition(tampered)).rejects.toThrow("definition/hash");
    expect((await revalidateDefinition(modified)).manifest).toEqual(modified.manifest);
  });

  it("rebuilds parsed fields from verified files and ignores forged cached schemas or manifests", async () => {
    const def = await parsePackageFiles(files());
    const forged = { ...def, manifest: { ...def.manifest, capabilities: ["network"], examples: ["TEST forged trigger"] },
      dataSchema: { type: "string" }, examples: [] };
    expect(await revalidateDefinition(forged)).toEqual(def);
  });

  it("revalidates newly added manifest fields rather than trusting a new hash alone", async () => {
    const def = await parsePackageFiles(files()), changed = structuredClone(def);
    (changed.files["manifest.json"] as Record<string, Json>).examples = ["https://example.test", "第二条有效例句", "第三条有效例句"];
    await expect(revalidateDefinition(changed)).rejects.toThrow("manifest.json/examples/0");
  });

  it("rejects duplicate or prototype JSON fields in the manifest and nested slots", async () => {
    const duplicate = files(); duplicate["manifest.json"] = duplicate["manifest.json"]!.replace('"formatVersion":"0.2"', '"formatVersion":"0.2","formatVersion":"0.1"');
    await expect(parsePackageFiles(duplicate)).rejects.toThrow("重复字段");
    const injected = files(); injected["manifest.json"] = injected["manifest.json"]!.replace('"slots":{', '"slots":{"__proto__":{},');
    await expect(parsePackageFiles(injected)).rejects.toThrow("禁止或重复字段");
  });
});

describe("v0.2 ZIP packages preserve all extraction boundaries", () => {
  it.each([0, 6] as const)("validates stored/deflated ZIP level %i with the same canonical hash", async level => {
    const def = await parsePackageFiles(files()), loaded = await readPackageZip(zip(files(), level));
    expect(loaded).toEqual(def); expect(await revalidateDefinition(loaded)).toEqual(def);
  });

  it.each(["../escape.json", "examples/../../escape.json", "renderer.js", "service.json"])("rejects ZIP path or executable addition %s", async path => {
    await expect(readPackageZip(zip({ ...files(), [path]: "{}" }))).rejects.toThrow();
  });

  it("rejects CRC tampering even when the altered manifest remains valid JSON", async () => {
    const bytes = zip(), marker = Buffer.from('"formatVersion":"0.2"'), at = Buffer.from(bytes).indexOf(marker);
    expect(at).toBeGreaterThan(0); bytes[at + marker.length - 2] = "1".charCodeAt(0);
    await expect(readPackageZip(bytes)).rejects.toThrow("ZIP 校验和");
  });

  it("rejects truncated ZIP directories and mismatched local/central paths", async () => {
    const bytes = zip(); await expect(readPackageZip(bytes.subarray(0, bytes.length - 22))).rejects.toThrow("ZIP 目录");
    const mismatch = zip(), at = Buffer.from(mismatch).indexOf(Buffer.from("manifest.json")); mismatch[at] = "x".charCodeAt(0);
    await expect(readPackageZip(mismatch)).rejects.toThrow("ZIP 本地与中央目录不匹配");
  });

  it("retains compressed, decompressed and file-count limits", async () => {
    await expect(readPackageZip(new Uint8Array(PACKAGE_LIMITS.compressedBytes + 1))).rejects.toThrow("1 MiB");
    await expect(readPackageZip(zip({ ...files(), "examples/oversized.json": " ".repeat(PACKAGE_LIMITS.fileBytes + 1) }, 6))).rejects.toThrow();
    const oversized = files(); for (let i = 0; i < PACKAGE_LIMITS.files; i++) oversized[`examples/example-${i}.json`] = "{}";
    await expect(readPackageZip(zip(oversized))).rejects.toThrow();
  });
});
