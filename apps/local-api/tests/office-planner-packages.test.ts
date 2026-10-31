import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { parsePackageFiles, validateInstance } from "@vivic/card-runtime";
import { CardRecordSchema } from "@vivic/contracts";
import { buildAllSceneActions, extensionScenePrompt, validateRequestDefinitions } from "../src/scenes/extensions.js";
import { runIntent } from "../src/intent/pipeline.js";
import { CredentialStore } from "../src/credentials.js";
import { emptyContext } from "./helpers.js";

const load = async (kind: string) => {
  const root = new URL(`../../../examples/card-packages/office-${kind}/`, import.meta.url);
  const paths = ["manifest.json", "config.schema.json", "data.schema.json", "state.schema.json", "ui.json", ...(await readdir(new URL("examples/", root))).map(file => `examples/${file}`)];
  return parsePackageFiles(Object.fromEntries(await Promise.all(paths.map(async file => [file, await readFile(new URL(file, root), "utf8")]))));
};

describe("office/planner packages in the real extension pipeline", () => {
  it.each(["tasks", "meeting", "week"])("%s: accepts grounded model data and retains exact package identity", async kind => {
    const def = await load(kind);
    expect(await validateRequestDefinitions([def])).toHaveLength(1);
    for (const example of def.examples) expect(() => validateInstance(def, example)).not.toThrow();
    const props = { config: { title: "准备评审", ...(kind === "week" ? { period: "本周" } : {}) }, data: { origin: "user" }, state: { items: [{ id: "review", title: "整理评审材料", owner: "我", due: "周五", status: "待办", ...(kind === "week" ? { day: "周五" } : {}) }] } };
    const text = `用${def.manifest.name}整理：准备评审，我在本周周五整理评审材料，待办。`;
    expect(extensionScenePrompt([def], text)).toContain('"schemas"');
    expect(extensionScenePrompt([def], text)).toContain(`ext.${def.manifest.id}`);
    const raw = [{ scene_id: `ext.${def.manifest.id}`, data: props }];
    const built = await buildAllSceneActions(raw, { text, ctx: emptyContext() }, [def]);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.cards).toHaveLength(1);
      expect(CardRecordSchema.safeParse(JSON.parse(JSON.stringify(built.cards[0]))).success).toBe(true);
      expect(built.cards[0]).toMatchObject({ type: "ExtensionCard", displayProps: { def: { hash: def.hash }, data: { origin: "user" } }, sources: [] });
    }
    const generate = vi.fn(async () => ({ ok: true as const, value: { cards: raw } }));
    const result = await runIntent({ text, canvasContext: emptyContext(), extensionDefinitions: [def] }, {
      credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" }, planner: { provider: "gpt", connected: true, isCurrent: () => true, generate },
    });
    expect(result.kind).toBe("envelope"); expect(generate).toHaveBeenCalledTimes(1);
    expect(result.envelope?.actions).toContainEqual(expect.objectContaining({ type: "card.create", card: expect.objectContaining({ type: "ExtensionCard" }) }));
  });
  it("rejects live provenance, invalid status, undeclared script fields, absent definitions and whole failed batches", async () => {
    const def = await load("meeting"), valid = { config: { title: "评审行动" }, data: { origin: "user" }, state: { items: [{ id: "review", title: "整理材料", status: "待办" }] } };
    const raw = (data: unknown) => ({ scene_id: `ext.${def.manifest.id}`, data });
    for (const invalid of [
      { ...valid, data: { origin: "live" } },
      { ...valid, state: { items: [{ id: "review", title: "整理材料", status: "已同步飞书" }] } },
      { ...valid, config: { ...valid.config, script: "run()" } },
      { ...valid, state: { items: Array.from({ length: 41 }, () => valid.state.items[0]) } },
      { ...valid, state: { items: [{ id: "review", title: "整理材料", status: "待办", due: "2099-01-01" }] } },
    ]) expect((await buildAllSceneActions([raw(valid), raw(invalid)], { text: "用会议行动卡整理评审行动，整理材料，待办。", ctx: emptyContext() }, [def])).ok).toBe(false);
    expect((await buildAllSceneActions([raw(valid)], { text: "整理材料", ctx: emptyContext() }, [])).ok).toBe(false);
  });
});
