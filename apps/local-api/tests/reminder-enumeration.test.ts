import { describe, expect, it, vi } from "vitest";
import type { Action } from "@vivic/contracts";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type IntentResult } from "../src/intent/pipeline.js";
import {
  parseEnumeratedReminders,
  parseExactReminders,
  reminderCoverageIssue,
} from "../src/intent/reminders.js";
import { chatOk, emptyContext, fetchStub } from "./helpers.js";

const credential = { apiKey: "unit-reminder-key-only", models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "now" };
const setup = (handler: (init?: RequestInit) => Response | Promise<Response>) => {
  const credentials = new CredentialStore();
  credentials.set(credential);
  const call = vi.fn(handler);
  return { deps: { credentials, stepfun: { baseUrl: "https://unit.test/v1", fetchImpl: fetchStub({ "/chat/completions": call }) } }, call };
};
const created = (result: IntentResult) => (result.envelope?.actions ?? [])
  .filter((action): action is Extract<Action, { type: "card.create" }> => action.type === "card.create")
  .map((action) => action.card);
const reminderTexts = (result: IntentResult) => created(result)
  .filter((card) => card.type === "CountdownCard")
  .map((card) => card.sourceData.reminderText);

describe("conservative reminder item enumeration", () => {
  it.each([
    ["五分钟后提醒我喝水和吃药", ["喝水", "吃药"]],
    ["五分钟后提醒我喝水", ["喝水"]],
    ["五分钟后提醒我和家人开会", ["和家人开会"]],
  ])("enumerates %s as %j", (text, items) => {
    const reminders = parseEnumeratedReminders(text);
    expect(reminders?.map((reminder) => reminder.text)).toEqual(items);
    expect(reminders?.every((reminder) => reminder.afterSeconds === 300)).toBe(true);
  });

  it.each([
    ["五分钟后提醒我喝水、吃药", ["喝水", "吃药"]],
    ["五分钟后提醒我喝水，吃药", ["喝水", "吃药"]],
    ["五分钟后提醒我喝水及吃药", ["喝水", "吃药"]],
    ["五分钟后提醒我喝水以及吃药", ["喝水", "吃药"]],
    ["五分钟后提醒我喝水还有吃药", ["喝水", "吃药"]],
  ])("splits explicit separators in %s", (text, items) => {
    expect(parseEnumeratedReminders(text)?.map((reminder) => reminder.text)).toEqual(items);
  });

  it("keeps each clause's own duration", () => {
    expect(parseEnumeratedReminders("五分钟后提醒我喝水，十分钟后提醒我吃药")).toEqual([
      { afterSeconds: 300, text: "喝水" },
      { afterSeconds: 600, text: "吃药" },
    ]);
  });

  it.each([
    "五分钟后提醒我关注和平",
    "五分钟后提醒我关注和平发展",
    "五分钟后提醒我保持温和",
    "五分钟后提醒我买票及时到场",
    "五分钟后提醒我涉及隐私",
    "五分钟后提醒我去埃及旅行",
    "五分钟后提醒我开会和客户吃饭",
  ])("does not mis-split lexical or comitative text %s", (text) => {
    expect(parseEnumeratedReminders(text)?.map((reminder) => reminder.text)).toHaveLength(1);
  });

  it("keeps the deterministic single-item and 、 list contract unchanged", () => {
    expect(parseExactReminders("五分钟后提醒我喝水")).toEqual([{ afterSeconds: 300, text: "喝水" }]);
    expect(parseExactReminders("五分钟后提醒我喝水、吃药"))
      .toEqual([{ afterSeconds: 300, text: "喝水" }, { afterSeconds: 300, text: "吃药" }]);
  });

  it("defers a bare 及 list instead of folding it into one reminder text", () => {
    expect(parseExactReminders("五分钟后提醒我喝水及吃药")).toBeNull();
  });
});

describe("reminder coverage requires every enumerated item", () => {
  const text = "五分钟后提醒我喝水和吃药";
  it("rejects one folded item or a dropped item", () => {
    expect(reminderCoverageIssue(text, [{ afterSeconds: 300, text: "喝水和吃药" }]))
      .toBe("遗漏或更改了明确的提醒事项");
    expect(reminderCoverageIssue(text, [{ afterSeconds: 300, text: "喝水" }]))
      .toBe("遗漏或更改了明确的提醒事项");
  });

  it("accepts one reminder per enumerated item", () => {
    expect(reminderCoverageIssue(text, [
      { afterSeconds: 300, text: "喝水" },
      { afterSeconds: 300, text: "吃药" },
    ])).toBeNull();
  });

  it("does not demand a split for a comitative phrase", () => {
    expect(reminderCoverageIssue("五分钟后提醒我和家人开会", [{ afterSeconds: 300, text: "和家人开会" }])).toBeNull();
  });
});

describe("reminder coverage falls back to the whole phrase when splitting fails", () => {
  it("rejects one reminder that folds a 然后 item", () => {
    expect(reminderCoverageIssue("五分钟后提醒我喝水然后吃药", [{ afterSeconds: 300, text: "喝水然后吃药" }]))
      .toBe("遗漏或更改了明确的提醒事项");
  });

  it("rejects folding a second 提醒 clause into the first reminder", () => {
    expect(reminderCoverageIssue("五分钟后提醒我喝水、吃药，再提醒我休息",
      [{ afterSeconds: 300, text: "喝水、吃药，再提醒我休息" }]))
      .toBe("遗漏或更改了明确的提醒事项");
  });

  it("rejects a dropped item behind 再提醒我", () => {
    expect(reminderCoverageIssue("五分钟后提醒我喝水、吃药，再提醒我休息", [
      { afterSeconds: 300, text: "喝水" }, { afterSeconds: 300, text: "吃药" },
    ])).toBe("遗漏或更改了明确的提醒事项");
  });

  it("accepts one reminder per item even though the split is not deterministic", () => {
    expect(reminderCoverageIssue("五分钟后提醒我喝水然后吃药", [
      { afterSeconds: 300, text: "喝水" }, { afterSeconds: 300, text: "吃药" },
    ])).toBeNull();
    expect(reminderCoverageIssue("五分钟后提醒我喝水、吃药，再提醒我休息", [
      { afterSeconds: 300, text: "喝水" }, { afterSeconds: 300, text: "吃药" }, { afterSeconds: 300, text: "休息" },
    ])).toBeNull();
    // A duration may follow the trigger itself; it is not part of the item.
    expect(reminderCoverageIssue("请提醒我五分钟后喝水然后吃药", [
      { afterSeconds: 300, text: "喝水" }, { afterSeconds: 300, text: "吃药" },
    ])).toBeNull();
  });

  it("does not mis-split a single item followed by the user's own next action", () => {
    expect(reminderCoverageIssue("现在提醒我喝水然后睡觉", [{ afterSeconds: 60, text: "喝水" }])).toBeNull();
    expect(reminderCoverageIssue("五分钟后提醒我和家人开会", [{ afterSeconds: 300, text: "和家人开会" }])).toBeNull();
    expect(reminderCoverageIssue("五分钟后提醒我涉及预算的部分", [{ afterSeconds: 300, text: "涉及预算的部分" }])).toBeNull();
  });

  it("rejects two reminders when the user named one item", () => {
    expect(reminderCoverageIssue("五分钟后提醒我和家人开会", [
      { afterSeconds: 300, text: "家人" }, { afterSeconds: 300, text: "开会" },
    ])).toBe("遗漏或更改了明确的提醒事项");
  });
});

describe("reminder pipeline handles 和 without losing an item", () => {
  it("splits 喝水和吃药 deterministically instead of letting the model fold it", async () => {
    // The deterministic grammar owns this shape now; even a folding model reply
    // is never requested, so the item can neither be folded nor dropped.
    const f = setup(() => chatOk({ reminders: [{ afterSeconds: 300, text: "喝水和吃药" }] }));
    const result = await runIntent({ text: "五分钟后提醒我喝水和吃药", canvasContext: emptyContext() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(reminderTexts(result)).toEqual(["喝水", "吃药"]);
    expect(f.call).not.toHaveBeenCalled();
  });

  it("keeps one card per item and one batch camera move", async () => {
    const f = setup(() => chatOk({ reminders: [
      { afterSeconds: 300, text: "喝水" },
      { afterSeconds: 300, text: "吃药" },
    ] }));
    const result = await runIntent({ text: "五分钟后提醒我喝水和吃药", canvasContext: emptyContext() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(reminderTexts(result)).toEqual(["喝水", "吃药"]);
    expect(result.envelope?.actions.at(-1)?.type).toBe("canvas.fit");
    expect(result.envelope?.actions.some((action) => action.type === "card.focus")).toBe(false);
  });

  it("keeps the offline single-item rule and its card shape unchanged", async () => {
    const f = setup(() => { throw new Error("must stay local"); });
    const result = await runIntent({ text: "五分钟后提醒我喝水", canvasContext: emptyContext() }, f.deps);
    expect(result.usedProvider).toBe("rules");
    expect(f.call).not.toHaveBeenCalled();
    expect(reminderTexts(result)).toEqual(["喝水"]);
    expect(result.envelope?.actions.at(-1)?.type).toBe("card.focus");
  });

  it("keeps 和家人开会 as one reminder", async () => {
    const f = setup(() => chatOk({ reminders: [{ afterSeconds: 300, text: "和家人开会" }] }));
    const result = await runIntent({ text: "五分钟后提醒我和家人开会", canvasContext: emptyContext() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(reminderTexts(result)).toEqual(["和家人开会"]);
    expect(f.call).toHaveBeenCalledTimes(1);
  });
});

describe("reminder pipeline keeps both items of a 然后 request", () => {
  it("creates two cards when the model returns both items", async () => {
    const f = setup(() => chatOk({ reminders: [
      { afterSeconds: 300, text: "喝水" },
      { afterSeconds: 300, text: "吃药" },
    ] }));
    const result = await runIntent({ text: "五分钟后提醒我喝水然后吃药", canvasContext: emptyContext() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(reminderTexts(result)).toEqual(["喝水", "吃药"]);
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  it("clarifies when the model folds the 然后 item into one reminder", async () => {
    const f = setup(() => chatOk({ reminders: [{ afterSeconds: 300, text: "喝水然后吃药" }] }));
    const result = await runIntent({ text: "五分钟后提醒我喝水然后吃药", canvasContext: emptyContext() }, f.deps);
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
    expect(f.call).toHaveBeenCalledTimes(2);
  });

  it("clarifies when the model folds a second 提醒 clause into the first", async () => {
    const f = setup(() => chatOk({ reminders: [{ afterSeconds: 300, text: "喝水、吃药，再提醒我休息" }] }));
    const result = await runIntent({ text: "五分钟后提醒我喝水、吃药，再提醒我休息", canvasContext: emptyContext() }, f.deps);
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
    expect(f.call).toHaveBeenCalledTimes(2);
  });
});
