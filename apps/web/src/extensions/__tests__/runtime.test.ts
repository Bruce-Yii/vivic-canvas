// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { canonicalJson, parsePackageFiles, readPackageZip, revalidateDefinition, validateInstance, parseValueSchema, parseJson, resolvePointer } from "@vivic/card-runtime";
import { TestSpaceSession } from "../TestSpaceSession";

const sample = resolve(import.meta.dirname, "../../../../..", "examples/card-packages/goal-progress");
async function files() {
  const result: Record<string, string> = {};
  for (const name of ["manifest.json", "config.schema.json", "data.schema.json", "state.schema.json", "ui.json"]) result[name] = await readFile(resolve(sample, name), "utf8");
  for (const name of await readdir(resolve(sample, "examples"))) result[`examples/${name}`] = await readFile(resolve(sample, "examples", name), "utf8");
  return result;
}
const zip = (input: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(input).map(([name, text]) => [name, strToU8(text)])));

describe("declarative card package trust boundary", () => {
  it("validates the real reference directory and standard ZIP with identical canonical identity", async () => {
    const input = await files(), definition = await parsePackageFiles(input), zipped = await readPackageZip(zip(input));
    expect(zipped.hash).toBe(definition.hash); expect(definition.examples.length).toBe(3);
    const reordered = Object.fromEntries(Object.entries(input).reverse().map(([name, text]) => [name, JSON.stringify(JSON.parse(text), null, 2)]));
    expect((await parsePackageFiles(reordered)).hash).toBe(definition.hash);
    expect((await revalidateDefinition(JSON.parse(JSON.stringify(definition)))).hash).toBe(definition.hash);
  });
  it("rejects missing files, unsupported schema, invalid examples and executing UI", async () => {
    const input = await files();
    await expect(parsePackageFiles({ ...input, "manifest.json": "{}" })).rejects.toThrow("manifest.json");
    await expect(parsePackageFiles({ ...input, "data.schema.json": '{"type":"object","$ref":"https://evil.test"}' })).rejects.toThrow("$ref");
    await expect(parsePackageFiles({ ...input, "examples/default.json": '{"name":"bad","config":{},"data":{},"state":{}}' })).rejects.toThrow("缺少必需字段");
    await expect(parsePackageFiles({ ...input, "ui.json": '{"components":[{"component":"Header","bind":"${fetch(1)}"}]}' })).rejects.toThrow("JSON Pointer");
    await expect(parsePackageFiles({ ...input, "ui.json": '{"components":[{"component":"Script","text":"alert(1)"}]}' })).rejects.toThrow("受控目录");
    await expect(parsePackageFiles({ ...input, "ui.json": '{"components":[{"component":"Header","text":"hello","onclick":"alert(1)"}]}' })).rejects.toThrow("onclick");
  });
  it("rejects ZIP traversal, duplicate entries, oversized files and decompression bombs", async () => {
    const input = await files();
    await expect(readPackageZip(zip({ ...input, "../manifest.json": "{}" }))).rejects.toThrow();
    await expect(readPackageZip(zip({ ...input, "examples/oversized.json": " ".repeat(262145) }))).rejects.toThrow();
    await expect(readPackageZip(new Uint8Array([80, 75, 0, 0]))).rejects.toThrow();
    await expect(parsePackageFiles({ ...input, "examples\\bad.json": "{}" })).rejects.toThrow("路径");
    await expect(parsePackageFiles({ ...input, "/manifest.json": "{}" })).rejects.toThrow("路径");
    const repeated = zip({ ...input, "examples/one.json": input["examples/default.json"]!, "examples/two.json": input["examples/default.json"]! });
    const needle = new TextEncoder().encode("examples/two.json"), replacement = new TextEncoder().encode("examples/one.json");
    for (let i = 0; i <= repeated.length - needle.length; i++) if (needle.every((byte, j) => repeated[i + j] === byte)) repeated.set(replacement, i);
    await expect(readPackageZip(repeated)).rejects.toThrow("重复");
    const truncated = zip(input).subarray(0, -22);
    await expect(readPackageZip(truncated)).rejects.toThrow("目录缺失");
    const corruptCrc = zip(input), view = new DataView(corruptCrc.buffer);
    for (let i = 0; i < corruptCrc.length - 20; i++) if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 16, view.getUint32(i + 16, true) ^ 1, true); break; }
    await expect(readPackageZip(corruptCrc)).rejects.toThrow("校验和");
    const symlink = zip(input), symlinkView = new DataView(symlink.buffer);
    for (let i = 0; i < symlink.length - 46; i++) if (symlinkView.getUint32(i, true) === 0x02014b50) { symlinkView.setUint32(i + 38, 0xa1ff0000, true); break; }
    await expect(readPackageZip(symlink)).rejects.toThrow("符号链接");
  });
  it("rejects duplicate/prototype JSON fields, references and unknown schema keywords", () => {
    expect(() => parseJson('{"x":1,"x":2}', "test")).toThrow("重复字段");
    expect(() => parseJson('{"__proto__":{}}', "test")).toThrow("禁止");
    expect(() => parseJson('{"x":1e999}', "test")).toThrow("有限");
    expect(() => parseValueSchema({ type: "string", pattern: ".*" }, "test")).toThrow("pattern");
    expect(() => parseValueSchema({ type: "object", properties: {}, additionalProperties: true }, "test")).toThrow("additionalProperties:false");
    expect(resolvePointer({ config: { title: "hello" } }, "/config/title")).toBe("hello");
    expect(resolvePointer({}, "/config/constructor")).toBeUndefined();
  });
  it("rechecks immutable package hash and schema values at runtime", async () => {
    const definition = await parsePackageFiles(await files()), valid = definition.examples[0]!;
    expect(() => validateInstance(definition, valid)).not.toThrow();
    expect(() => validateInstance(definition, { ...valid, data: { target: -1 } })).toThrow("data/target");
    const tampered = structuredClone(definition); tampered.files["manifest.json"] = { ...JSON.parse(canonicalJson(tampered.files["manifest.json"])), name: "changed" };
    await expect(revalidateDefinition(tampered)).rejects.toThrow("hash");
    let deep: unknown = {}; for (let i = 0; i < 1000; i++) deep = { child: deep };
    await expect(revalidateDefinition({ hash: definition.hash, files: { "manifest.json": deep } })).rejects.toThrow("嵌套");
  });
  it("keeps DEMO sessions isolated, invalidates old runs and requires rerun after editing", async () => {
    const definition = await parsePackageFiles(await files()), a = new TestSpaceSession(definition), b = new TestSpaceSession(definition);
    expect(a.token).not.toBe(b.token); expect(a.card.id).not.toBe(b.card.id);
    expect(a.canInstall).toBe(false); expect(await a.run()).toBe(true); expect(a.canInstall).toBe(true);
    a.setConfig({ ...a.card.displayProps.config, title: "changed" }); expect(a.canInstall).toBe(false);
    const late = a.run(); a.cancel(); expect(await late).toBe(false);
    const closing = a.run(); a.close(); expect(await closing).toBe(false); expect(a.canInstall).toBe(false);
    expect(b.store.getState().cards).toHaveLength(1); b.close();
  });
});
