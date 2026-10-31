import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { parsePackageFiles } from "@vivic/card-runtime";
import { CardRecordSchema } from "@vivic/contracts";
import { buildAllSceneActions, extensionScenePrompt, validateRequestDefinitions } from "../src/scenes/extensions.js";
import { CredentialStore } from "../src/credentials.js";
import { runIntent } from "../src/intent/pipeline.js";
import { emptyContext } from "./helpers.js";
const definition = async () => {
  const paths = ["manifest.json", "config.schema.json", "data.schema.json", "state.schema.json", "ui.json", "examples/default.json"];
  const files = Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(new URL(`../../../examples/card-packages/goal-progress/${path}`, import.meta.url), "utf8")])));
  return parsePackageFiles(files);
};
const props = { config: { title: "读书", unit: "本" }, data: { target: 50 }, state: { current: 18, percent: 36, note: "" } };
const text = "用个人目标进度卡记录读书，目标50本，已完成18本，百分比36";
describe("installed declarative extension scenes", () => {
  it("validates exact hash and only injects selected definitions' schemas", async () => {
    const def = await definition();
    expect(await validateRequestDefinitions([def])).toHaveLength(1);
    await expect(validateRequestDefinitions([{ ...def, hash: "0".repeat(64) }])).rejects.toThrow();
    expect(extensionScenePrompt([def], text)).toContain('"schemas"');
    expect(extensionScenePrompt([def], "你好")).not.toContain('"schemas"');
  });
  it("builds only enabled, structurally valid and grounded extension instances", async () => {
    const def = await definition();
    const raw = [{ scene_id: `ext.${def.manifest.id}`, data: props }];
    expect((await buildAllSceneActions(raw, { text, ctx: emptyContext() }, [])).ok).toBe(false);
    const built = await buildAllSceneActions(raw, { text, ctx: emptyContext() }, [def]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(CardRecordSchema.safeParse(built.cards[0]).success).toBe(true);
    expect(built.cards[0]).toMatchObject({ type: "ExtensionCard", displayProps: { def: { hash: def.hash } } });
    const fabricated = [{ scene_id: `ext.${def.manifest.id}`, data: { ...props, data: { target: 999 } } }];
    expect((await buildAllSceneActions(fabricated, { text, ctx: emptyContext() }, [def])).ok).toBe(false);
  });
  it("routes planner dynamic scenes through exact installed schema validation", async () => {
    const def = await definition();
    const generate = vi.fn(async () => ({ ok: true as const, value: { cards: [{ scene_id: `ext.${def.manifest.id}`, data: props }] } }));
    const result = await runIntent({ text, canvasContext: emptyContext(), extensionDefinitions: [def] }, {
      credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" },
      planner: { provider: "gpt", connected: true, isCurrent: () => true, generate },
    });
    expect(result.kind).toBe("envelope");
    expect(result.envelope?.actions).toContainEqual(expect.objectContaining({ type: "card.create", card: expect.objectContaining({ type: "ExtensionCard" }) }));
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
