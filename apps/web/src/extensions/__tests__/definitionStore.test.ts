// @vitest-environment node
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { definitionKey, definitionRef, parsePackageFiles } from "@vivic/card-runtime";
import { openVivicDB } from "@/persistence/db";
import { createExtensionInstance } from "../extensionInstance";
import { enabledPlannerDefinitions, extensionDefinitions, validateExtensionCard } from "../definitionStore";

const object = (properties: Record<string, unknown> = {}, required: string[] = []) => JSON.stringify({ type: "object", properties, required, additionalProperties: false });
const input = {
  "manifest.json": JSON.stringify({ formatVersion: "0.1", id: "example.persist", version: "1.0.0", name: "持久化示例", description: "TEST", renderer: "declarative", host: "0.6", capabilities: [] }),
  "config.schema.json": object({ title: { type: "string", maxLength: 80 } }, ["title"]),
  "data.schema.json": object({ count: { type: "integer", minimum: 0 } }, ["count"]),
  "state.schema.json": object(), "ui.json": JSON.stringify({ components: [{ component: "Header", bind: "/config/title" }] }),
  "examples/demo.json": JSON.stringify({ name: "DEMO", config: { title: "hello" }, data: { count: 1 }, state: {} }),
};
beforeEach(async () => {
  const db = await openVivicDB(); for (const row of await db.loadCardDefinitions()) await db.deleteCardDefinition(row.key); db.close();
  extensionDefinitions.resetMemory();
});
describe("installed declarative definitions", () => {
  it("installs exactly once, restores after memory restart and preserves instances through disable/uninstall/reimport", async () => {
    const definition = await parsePackageFiles(input), ref = definitionRef(definition), instance = createExtensionInstance(definition, definition.examples[0]!);
    expect(validateExtensionCard(instance).ok).toBe(false);
    await extensionDefinitions.install(definition, definition.hash);
    expect(validateExtensionCard(instance).ok).toBe(true);
    expect(enabledPlannerDefinitions()).toHaveLength(1);
    await extensionDefinitions.install(definition, definition.hash);
    expect(extensionDefinitions.list()).toHaveLength(1);
    extensionDefinitions.resetMemory(); await extensionDefinitions.ready();
    expect(validateExtensionCard(instance).ok).toBe(true);
    await extensionDefinitions.setEnabled(ref, false); expect(validateExtensionCard(instance).ok).toBe(false); expect(enabledPlannerDefinitions()).toHaveLength(0);
    await extensionDefinitions.setEnabled(ref, true); expect(validateExtensionCard(instance).ok).toBe(true);
    await extensionDefinitions.uninstall(ref); expect(validateExtensionCard(instance).ok).toBe(false);
    expect(instance.displayProps.config.title).toBe("hello");
    await extensionDefinitions.install(definition, definition.hash); expect(validateExtensionCard(instance).ok).toBe(true);
  });
  it("rejects changed same-version packages and invalid runtime values", async () => {
    const definition = await parsePackageFiles(input); await extensionDefinitions.install(definition, definition.hash);
    const changed = await parsePackageFiles({ ...input, "examples/demo.json": JSON.stringify({ name: "DEMO", config: { title: "changed" }, data: { count: 1 }, state: {} }) });
    await expect(extensionDefinitions.install(changed, changed.hash)).rejects.toThrow("增加版本号");
    await expect(extensionDefinitions.install(definition, "0".repeat(64))).rejects.toThrow("变化");
    const instance = createExtensionInstance(definition, definition.examples[0]!); instance.displayProps.data.count = -1;
    expect(validateExtensionCard(instance).ok).toBe(false);
    const nextManifest = { ...JSON.parse(input["manifest.json"]), version: "1.1.0" };
    const newer = await parsePackageFiles({ ...input, "manifest.json": JSON.stringify(nextManifest) });
    await extensionDefinitions.install(newer, newer.hash);
    expect(extensionDefinitions.list()).toHaveLength(2);
    expect(enabledPlannerDefinitions()).toHaveLength(1); expect(enabledPlannerDefinitions()[0]!.manifest.version).toBe("1.1.0");
    await extensionDefinitions.setEnabled(definitionRef(newer), false);
    expect(enabledPlannerDefinitions()[0]!.manifest.version).toBe("1.0.0");
  });
  it("does not install canceled sessions or trust corrupted persisted schema fields", async () => {
    const definition = await parsePackageFiles(input); let active = true;
    const pending = extensionDefinitions.install(definition, definition.hash, () => active); active = false;
    await expect(pending).rejects.toThrow("失效"); expect(extensionDefinitions.list()).toHaveLength(0);
    const db = await openVivicDB();
    const corrupted = structuredClone(definition); corrupted.files["ui.json"] = { components: [{ component: "Script", text: "evil" }] };
    await db.saveCardDefinition({ key: definitionKey(definitionRef(definition)), definition: corrupted, enabled: true }); db.close();
    extensionDefinitions.resetMemory(); await extensionDefinitions.ready();
    expect(extensionDefinitions.list()).toHaveLength(0); expect(extensionDefinitions.error()).toContain("损坏");
    const check = await openVivicDB(); expect(await check.loadCardDefinitions()).toHaveLength(1); check.close();
  });
  it("does not restore a prior definition when data reset cancels a reinstall during its transaction", async () => {
    const definition = await parsePackageFiles(input); await extensionDefinitions.install(definition, definition.hash);
    let active = true, cancelNext = true;
    const original = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = key === undefined ? original.call(this, value) : original.call(this, value, key);
      if (this.name === "definitions" && cancelNext) {
        cancelNext = false;
        queueMicrotask(() => { active = false; extensionDefinitions.resetMemory(); });
      }
      return request;
    });
    try {
      await expect(extensionDefinitions.install(definition, definition.hash, () => active)).rejects.toThrow("取消");
      expect(extensionDefinitions.list()).toHaveLength(0);
      const db = await openVivicDB(); expect(await db.loadCardDefinitions()).toHaveLength(0); db.close();
    } finally { spy.mockRestore(); }
  });
  it.each(["install", "disable", "uninstall"] as const)("a slow hash-validating reload cannot undo a completed %s", async action => {
    const definition = await parsePackageFiles(input);
    const second = await parsePackageFiles({ ...input, "manifest.json": JSON.stringify({ ...JSON.parse(input["manifest.json"]), id: "example.second" }) });
    await extensionDefinitions.install(definition, definition.hash);
    let release = () => {}, notifyEntered = () => {}, holdNext = true;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { notifyEntered = resolve; });
    const original = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      if (holdNext) { holdNext = false; notifyEntered(); await gate; }
      return original(algorithm, data);
    });
    const stale = extensionDefinitions.refresh();
    try {
      // The refresh has already read the old IDB rows and now waits on their real content hash.
      await entered;
      if (action === "install") await extensionDefinitions.install(second, second.hash);
      else if (action === "disable") await extensionDefinitions.setEnabled(definitionRef(definition), false);
      else await extensionDefinitions.uninstall(definitionRef(definition));
      release(); await stale;
      if (action === "install") expect(extensionDefinitions.get(definitionRef(second))).toBeDefined();
      else if (action === "disable") expect(extensionDefinitions.list().find(row => row.definition.manifest.id === definition.manifest.id)?.enabled).toBe(false);
      else expect(extensionDefinitions.list()).toHaveLength(0);
    } finally { release(); await stale; spy.mockRestore(); }
  });
});
