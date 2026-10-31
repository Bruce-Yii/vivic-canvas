import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parsePackageFiles, type CardDefinition } from "@vivic/card-runtime";
import { ROUTES, type IntentRouteId } from "@vivic/contracts";
import { createIntentRouter, type RouteResult } from "../src/decision/router.js";
import { currentCardDefinitions } from "../src/cards/catalog.js";
import type { CanvasContext } from "../src/schemas.js";

type Question = { type: string; instructions: string; criteria: Record<string, string> };
type Body = { model: string; state: { user_message: string; canvas?: { focused_card: string | null; cards: Array<{ id: string; desc: string }> } };
  questions: Record<string, Question> };
const context = (size = 0): CanvasContext => ({ canvasId: "TEST-canvas", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: size ? [`TEST-card-${size - 1}`] : [], cards: Array.from({ length: size }, (_, index) => ({
    id: `TEST-card-${index}`, type: "NoteCard", displayProps: { text: `TEST private card body ${index}` },
    sourceDataSummary: {}, layout: { x: index * 320, y: 0, width: 300, height: 120, pinned: false },
  })) });
let originalFiles: Record<string, string>;
let fitness: CardDefinition;
beforeAll(async () => {
  const paths = ["manifest.json", "config.schema.json", "data.schema.json", "state.schema.json", "ui.json", "examples/default.json"];
  originalFiles = Object.fromEntries(await Promise.all(paths.map(async path => [path,
    await readFile(new URL(`../../../examples/vivicard/fitness-log/${path}`, import.meta.url), "utf8")])));
  fitness = await parsePackageFiles(originalFiles);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function definition(id: string, overrides: Record<string, unknown> = {}): Promise<CardDefinition> {
  return parsePackageFiles({ ...originalFiles, "manifest.json": JSON.stringify({ ...JSON.parse(originalFiles["manifest.json"]!), id,
    name: `TEST ${id}`, ...overrides }) });
}
const answer = (name: string, value: unknown) => Response.json({ answers: { [name]: value } });
function fixture(handler: (body: Body, signal: AbortSignal) => Response | Promise<Response>) {
  const bodies: Body[] = [];
  const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Body; bodies.push(body);
    return handler(body, init!.signal!);
  });
  // Explicit synthetic transport settings avoid environment credentials and network access.
  const router = createIntentRouter({ mode: "on", model: "TEST-classifier", url: "https://unit.test/route", apiKey: "TEST-fixture-only",
    directRoutes: ["countdown", "todo", "note", "overview", "restore", "focus"], timeoutMs: 500, fetchImpl: fetchImpl as typeof fetch });
  return { router, bodies, fetchImpl };
}
const aggregate = (probability = .8) => answer("route", { choice: "ext", probabilities: { ext: probability, note: 1 - probability } });
const abstains = (result: RouteResult | null) => expect(result === null || result.none).toBe(true);

describe("per-request installed extension scopes", () => {
  it("retains the legacy 16 labels and one RPC when there are no definitions", async () => {
    const f = fixture(() => answer("route", { choice: "note", probabilities: { note: .97, chat: .03 } }));
    const result = await f.router.forDefinitions!([]).routeUtterance("记下今天练背", context());
    expect(result).toMatchObject({ route: "note", probability: .97, none: false });
    expect(Object.keys(f.bodies[0]!.questions.route!.criteria)).toEqual(Object.keys(ROUTES));
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("isolates simultaneous account scopes and leaves the base router unchanged", async () => {
    const a = await definition("test.account-a", { name: "甲账户训练卡" });
    const b = await definition("test.account-b", { name: "乙账户训练卡" });
    const f = fixture(body => body.questions.route!.criteria.ext ? aggregate() : answer("route", { choice: "note", probabilities: { note: 1 } }));
    const first = f.router.forDefinitions!([a]), second = f.router.forDefinitions!([b]);
    const results = await Promise.all([first.routeUtterance("TEST A", context()), second.routeUtterance("TEST B", context()), f.router.routeUtterance("TEST base", context())]);
    expect(results.map(result => result?.route)).toEqual(["ext.test.account-a", "ext.test.account-b", "note"]);
    const bodyA = f.bodies.find(body => body.state.user_message === "TEST A")!, bodyB = f.bodies.find(body => body.state.user_message === "TEST B")!;
    expect(bodyA.questions.route!.criteria.ext).toContain("甲账户训练卡"); expect(bodyA.questions.route!.criteria.ext).not.toContain("乙账户训练卡");
    expect(bodyB.questions.route!.criteria.ext).toContain("乙账户训练卡"); expect(bodyB.questions.route!.criteria.ext).not.toContain("甲账户训练卡");
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("removes disabled definitions from the next scope while preserving the earlier scope", async () => {
    const other = await definition("test.other", { name: "停用测试卡" });
    const f = fixture(body => body.questions.extension ? answer("extension", { choice: "ext.test.other", probabilities: { "ext.test.other": 1 } })
      : body.questions.route!.criteria.ext ? aggregate() : answer("route", { choice: "note", probabilities: { note: 1 } }));
    const previous = f.router.forDefinitions!([fitness, other]);
    const enabled = f.router.forDefinitions!([fitness]);
    expect((await enabled.routeUtterance("记录训练", context()))?.route).toBe(`ext.${fitness.manifest.id}`);
    expect(f.bodies[0]!.questions.route!.criteria.ext).not.toContain("停用测试卡");
    expect((await previous.routeUtterance("TEST previous", context()))?.route).toBe("ext.test.other");
    expect((await f.router.forDefinitions!([]).routeUtterance("TEST disabled all", context()))?.route).toBe("note");
    expect(f.bodies.at(-1)!.questions.route!.criteria).not.toHaveProperty("ext");
  });

  it("snapshots the enabled array instead of retaining a mutable list across requests", async () => {
    const original = await definition("test.snapshot-a"), replacement = await definition("test.snapshot-b");
    const enabled = [original], f = fixture(() => aggregate()), scoped = f.router.forDefinitions!(enabled);
    enabled.splice(0, 1, replacement);
    expect((await scoped.routeUtterance("TEST snapshot", context()))?.route).toBe("ext.test.snapshot-a");
  });

  it("snapshots manifest IDs and routing metadata before a caller mutates its definition", async () => {
    const original = await definition("test.original", { name: "原始训练卡" });
    const f = fixture(() => aggregate()), scoped = f.router.forDefinitions!([original]);
    original.manifest.id = "test.changed"; original.manifest.name = "变更后的训练卡"; original.manifest.examples = ["覆盖后的触发句甲", "覆盖后的触发句乙", "覆盖后的触发句丙"];
    const result = await scoped.routeUtterance("TEST original scope", context());
    expect(result?.route).toBe("ext.test.original");
    expect(f.bodies[0]!.questions.route!.criteria.ext).toContain("原始训练卡");
    expect(f.bodies[0]!.questions.route!.criteria.ext).not.toContain("变更后的训练卡");
  });

  it("rejects more than 16 enabled definition rows before any request", async () => {
    const defs = await Promise.all(Array.from({ length: 17 }, (_, index) => definition(`test.limit-${index}`)));
    const f = fixture(() => aggregate());
    expect(() => f.router.forDefinitions!(defs)).toThrow("Invalid enabled card catalog");
    expect(() => f.router.forDefinitions!([fitness, fitness])).not.toThrow();
    expect(() => f.router.forDefinitions!(defs.slice(0, 16))).not.toThrow();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it("uses the highest enabled version consistently rather than rejecting a multi-version installation", async () => {
    const old = await definition("test.versions", { version: "1.9.9", name: "旧版训练卡" });
    const fresh = await definition("test.versions", { version: "1.10.0", name: "新版训练卡" });
    const originalRef = { id: old.manifest.id, version: old.manifest.version, hash: old.hash };
    for (const enabled of [[fresh, old], [old, fresh]]) {
      expect(currentCardDefinitions(enabled)).toEqual([fresh]);
      const f = fixture(() => aggregate());
      const result = await f.router.forDefinitions!(enabled).routeUtterance("记录训练", context());
      expect(result?.route).toBe("ext.test.versions");
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
      expect(f.bodies[0]!.questions.route!.criteria.ext).toContain("新版训练卡");
      expect(f.bodies[0]!.questions.route!.criteria.ext).not.toContain("旧版训练卡");
    }
    const disabled = fixture(() => aggregate());
    expect(currentCardDefinitions([old])).toEqual([old]);
    await disabled.router.forDefinitions!([old]).routeUtterance("记录训练", context());
    expect(disabled.bodies[0]!.questions.route!.criteria.ext).toContain("旧版训练卡");
    expect({ id: old.manifest.id, version: old.manifest.version, hash: old.hash }).toEqual(originalRef);
  });

  it("never adds registered extensions to the E direct-route allowlist", async () => {
    const f = fixture(() => aggregate()), scoped = f.router.forDefinitions!([fitness]);
    expect([...scoped.directRoutes!]).toEqual([...f.router.directRoutes!]);
    expect(scoped.directRoutes?.has(`ext.${fitness.manifest.id}` as IntentRouteId)).toBe(false);
  });
});

describe("two-level extension choice and probability composition", () => {
  it("selects a sole installed extension in one RPC with its aggregate probability", async () => {
    const f = fixture(() => aggregate(.73)), result = await f.router.forDefinitions!([fitness]).routeUtterance("今天练了40分钟背", context());
    expect(result).toMatchObject({ route: `ext.${fitness.manifest.id}`, probability: .73, none: false });
    expect(result!.probabilities[`ext.${fitness.manifest.id}`]).toBe(.73);
    expect(result!.probabilities).not.toHaveProperty("ext");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(Object.keys(f.bodies[0]!.questions.route!.criteria)).toHaveLength(17);
  });

  it("uses exactly two questions and multiplies conditional extension probabilities", async () => {
    const other = await definition("test.other"), f = fixture(body => body.questions.route ? aggregate(.8)
      : answer("extension", { choice: `ext.${fitness.manifest.id}`, probabilities: { [`ext.${fitness.manifest.id}`]: .75, "ext.test.other": .25 } }));
    const result = await f.router.forDefinitions!([fitness, other]).routeUtterance("今天练了40分钟背", context());
    expect(f.bodies.map(body => Object.keys(body.questions))).toEqual([["route"], ["extension"]]);
    expect(Object.keys(f.bodies[1]!.questions.extension!.criteria)).toEqual([`ext.${fitness.manifest.id}`, "ext.test.other"]);
    expect(result?.route).toBe(`ext.${fitness.manifest.id}`); expect(result?.probability).toBeCloseTo(.6);
    expect(result?.probabilities[`ext.${fitness.manifest.id}`]).toBeCloseTo(.6);
    expect(result?.probabilities["ext.test.other"]).toBeCloseTo(.2); expect(result?.probabilities.note).toBeCloseTo(.2);
    expect(result?.probabilities).not.toHaveProperty("ext"); expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not request an extension question when the first choice is builtin or none", async () => {
    const other = await definition("test.other");
    for (const value of [{ choice: "todo", probabilities: { todo: .9, ext: .1 } }, { choice: null, probabilities: { ext: .1, note: .1 } },
      { choice: "ext", none: true, probabilities: { ext: .9, note: .1 } }]) {
      const f = fixture(() => answer("route", value));
      const result = await f.router.forDefinitions!([fitness, other]).routeUtterance("TEST abstain", context());
      if (value.choice === "todo") expect(result?.route).toBe("todo"); else abstains(result);
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    { choice: "ext", probabilities: {} }, { choice: "ext", probabilities: { note: .2 } },
    { choice: "ext" }, { choice: "ext", probabilities: { ext: "0.9" } },
    { choice: "ext", probabilities: { ext: 1.1 } }, { choice: "ext", probabilities: { ext: -1 } },
    { choice: "execute_script", probabilities: { note: 1 } },
    { choice: "ext.not-installed", probabilities: { ext: 1 } },
  ])("rejects an invalid aggregate answer %j", async value => {
    const f = fixture(() => answer("route", value));
    expect(await f.router.forDefinitions!([fitness]).routeUtterance("TEST invalid route", context())).toBeNull();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { choice: "ext.not-installed", probabilities: { "ext.test.other": 1 } },
    { choice: "ext.test.other", probabilities: {} }, { choice: "ext.test.other" },
    { choice: "ext.test.other", probabilities: { "ext.test.other": "0.9" } },
    { choice: "ext.test.other", probabilities: { "ext.test.other": .8, "ext.not-installed": .2 } },
  ])("rejects an invalid second-stage answer %j", async value => {
    const other = await definition("test.other"), f = fixture(body => body.questions.route ? aggregate() : answer("extension", value));
    expect(await f.router.forDefinitions!([fitness, other]).routeUtterance("TEST invalid extension", context())).toBeNull();
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves second-stage abstention instead of accepting it as a usable route", async () => {
    const other = await definition("test.other");
    for (const value of [{ choice: null, probabilities: { "ext.test.other": .4 } }, { choice: "ext.test.other", none: true, probabilities: { "ext.test.other": .9 } }]) {
      const f = fixture(body => body.questions.route ? aggregate() : answer("extension", value));
      abstains(await f.router.forDefinitions!([fitness, other]).routeUtterance("TEST none", context()));
    }
  });
});

describe("routing catalog compaction and bounded state", () => {
  it("includes real manifest trigger text and never injects package schemas into classification", async () => {
    const f = fixture(() => aggregate());
    await f.router.forDefinitions!([fitness]).routeUtterance("今天练了40分钟背", context());
    expect(f.bodies[0]!.questions.route!.criteria.ext).toContain(fitness.manifest.examples![0]);
    expect(JSON.stringify(f.bodies[0])).not.toContain('"properties"');
    expect(f.bodies[0]!.questions.route!.instructions).toContain("用户不必说卡名");
  });

  it("keeps at least one complete allowed trigger per definition within the aggregate catalog budget", async () => {
    const defs = await Promise.all(Array.from({ length: 16 }, (_, index) => {
      const prefix = `记录第${String(index).padStart(2, "0")}张卡片的训练目标`;
      return definition(`test.compact-${index}`, { name: "名".repeat(80), description: "说明".repeat(200),
        examples: [prefix + "长".repeat(40 - prefix.length), "记录今天训练目标", "帮我记下训练事实"] });
    }));
    const f = fixture(() => answer("route", { choice: "note", probabilities: { note: 1 } }));
    await f.router.forDefinitions!(defs).routeUtterance("TEST compact", context());
    const catalog = f.bodies[0]!.questions.route!.criteria.ext!;
    expect(catalog.slice(catalog.indexOf("：") + 1).length).toBeLessThanOrEqual(900);
    for (const def of defs) expect(catalog, `missing full trigger for ${def.manifest.id}`).toContain(def.manifest.examples![0]);
  });

  it("bounds the first request while retaining the focused card", async () => {
    const f = fixture(() => aggregate()), ctx = context(40), before = structuredClone(ctx);
    await f.router.forDefinitions!([fitness]).routeUtterance("记录训练", ctx);
    expect(f.bodies[0]!.state.canvas!.cards.length).toBeGreaterThan(0);
    expect(f.bodies[0]!.state.canvas!.cards.length).toBeLessThanOrEqual(8);
    expect(f.bodies[0]!.state.canvas!.cards[0]!.id).toBe("TEST-card-39");
    expect(f.bodies[0]!.state.canvas!.cards.every(card => card.desc.length <= 110)).toBe(true);
    expect(ctx).toEqual(before);
  });

  it("omits canvas entirely from the extension-only second question", async () => {
    const other = await definition("test.other"), f = fixture(body => body.questions.route ? aggregate()
      : answer("extension", { choice: "ext.test.other", probabilities: { "ext.test.other": 1 } }));
    await f.router.forDefinitions!([fitness, other]).routeUtterance("记录训练", context(40));
    expect(f.bodies[1]!.state).not.toHaveProperty("canvas");
    expect(JSON.stringify(f.bodies[1])).not.toContain("TEST private card body");
  });
});

describe("two-stage cancellation", () => {
  it("cancels an in-flight second RPC without publishing an extension", async () => {
    const other = await definition("test.other"), controller = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const f = fixture((body, signal) => body.questions.route ? aggregate() : new Promise<Response>((_resolve, reject) => {
      started(); signal.addEventListener("abort", () => reject(new DOMException("TEST aborted", "AbortError")), { once: true });
    }));
    const pending = f.router.forDefinitions!([fitness, other]).routeUtterance("记录训练", context(), controller.signal);
    await entered; controller.abort();
    expect(await pending).toBeNull(); expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not start a second RPC after cancellation while decoding the first response", async () => {
    const other = await definition("test.other"), controller = new AbortController();
    const f = fixture(body => {
      if (!body.questions.route) return answer("extension", { choice: "ext.test.other", probabilities: { "ext.test.other": 1 } });
      const response = aggregate();
      vi.spyOn(response, "json").mockImplementation(async () => {
        controller.abort(); return { answers: { route: { choice: "ext", probabilities: { ext: .9, note: .1 } } } };
      });
      return response;
    });
    expect(await f.router.forDefinitions!([fitness, other]).routeUtterance("记录训练", context(), controller.signal)).toBeNull();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("discards a second response decoded after cancellation even when its body reader ignores the signal", async () => {
    const other = await definition("test.other"), controller = new AbortController();
    const f = fixture(body => {
      if (body.questions.route) return aggregate();
      const response = answer("extension", {});
      vi.spyOn(response, "json").mockImplementation(async () => {
        controller.abort(); return { answers: { extension: { choice: "ext.test.other", probabilities: { "ext.test.other": 1 } } } };
      });
      return response;
    });
    expect(await f.router.forDefinitions!([fitness, other]).routeUtterance("记录训练", context(), controller.signal)).toBeNull();
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });
});
