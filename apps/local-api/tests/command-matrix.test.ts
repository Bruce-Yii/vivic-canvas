import { describe, expect, it } from "vitest";
import type { Action } from "@vivic/contracts";
import { matchRules } from "../src/intent/rules.js";
import { countdownContract } from "../src/cards/countdown.js";
import { todoContract } from "../src/cards/todo.js";
import { noteContract } from "../src/cards/note.js";
import { overviewContract, restoreContract } from "../src/cards/views.js";
import { splitClauses } from "../src/decision/split.js";
import { emptyContext } from "./helpers.js";

/**
 * Behaviour matrix for the deterministic command surface.
 *
 * The point is not one more regex per phrasing: the matrix crosses polite
 * prefixes, creation verbs, measure words, both duration/countdown word
 * orders, Chinese numerals, "的", and sentence-final punctuation. The same
 * matrix runs against the legacy fast rules (`matchRules`) and the
 * decision-path contracts (`CARD_CONTRACTS`), because the countdown latency
 * bug lived in both layers: the fast rule had been patched, the contract that
 * produces `directClauses` had not.
 */

type CreateAction = Extract<Action, { type: "card.create" }>;
const created = (actions: Action[]): CreateAction | undefined =>
  actions.find((action): action is CreateAction => action.type === "card.create");

const cardContext = () => {
  const ctx = emptyContext();
  ctx.cards.push({
    id: "card-1", type: "NoteCard", aliases: [], displayProps: { text: "x" }, sourceDataSummary: {},
    layout: { x: 0, y: 0, width: 100, height: 100, pinned: false },
  });
  return ctx;
};

const PREFIXES = ["", "帮我", "请", "请帮我", "给我", "请给我", "麻烦", "麻烦帮我", "请你", "麻烦你"];
const PUNCTUATION = ["", "。", "！", "!", " ", "  "];
const SHORT_PUNCTUATION = ["", "。", "！"];

const DURATIONS: Array<[string, number]> = [
  ["30分钟", 1800],
  ["三十分钟", 1800],
  ["半小时", 1800],
  ["1小时30分钟", 5400],
  ["90秒", 90],
  ["一个半小时", 5400],
  ["一刻钟", 900],
  ["一个钟头", 3600],
];

const COUNTDOWN_VERBS = ["创建", "新建", "设", "设置", "定", "来", "搞", "弄", "建", "加", "添加"];
const TODO_VERBS = ["添加", "新增", "创建", "新建", "记录", "安排", "列", "写", "加", "来", "搞", "弄", "建", "记"];
const NOTE_VERBS = ["创建", "新建", "添加", "新增", "写", "建", "来", "搞", "弄", "加", "记", "记录"];
const MEASURES = ["", "一个", "个"];
const NOTE_MEASURES = ["", "一个", "个", "一张", "张"];

const countdownCases: Array<{ text: string; seconds: number }> = [];
for (const [duration, seconds] of DURATIONS) {
  for (const punctuation of PUNCTUATION) {
    countdownCases.push(
      { text: `${duration}倒计时${punctuation}`, seconds },
      { text: `倒计时${duration}${punctuation}`, seconds },
      { text: `${duration}的倒计时${punctuation}`, seconds },
      { text: `倒计时 ${duration}${punctuation}`, seconds },
    );
  }
}
for (const prefix of PREFIXES) {
  for (const [duration, seconds] of DURATIONS) {
    for (const punctuation of SHORT_PUNCTUATION) {
      countdownCases.push({ text: `${prefix}倒计时${duration}${punctuation}`, seconds });
    }
  }
}
for (const prefix of PREFIXES) {
  for (const verb of COUNTDOWN_VERBS) {
    for (const measure of MEASURES) {
      countdownCases.push(
        { text: `${prefix}${verb}${measure}30分钟倒计时`, seconds: 1800 },
        { text: `${prefix}${verb}${measure}倒计时30分钟`, seconds: 1800 },
        { text: `${prefix}${verb}${measure}30分钟的倒计时`, seconds: 1800 },
      );
    }
  }
}

const todoCases: Array<{ text: string; items: string[] }> = [];
for (const prefix of PREFIXES) {
  for (const verb of TODO_VERBS) {
    for (const measure of MEASURES) {
      todoCases.push(
        { text: `${prefix}${verb}${measure}待办：买牛奶`, items: ["买牛奶"] },
        { text: `${prefix}${verb}${measure}待办买牛奶`, items: ["买牛奶"] },
      );
    }
  }
}
todoCases.push(
  { text: "待办：买牛奶", items: ["买牛奶"] },
  { text: "待办: 买牛奶", items: ["买牛奶"] },
  { text: "待办：买牛奶。", items: ["买牛奶"] },
  { text: "待办：买牛奶！", items: ["买牛奶"] },
  { text: "待办：买牛奶；交周报", items: ["买牛奶", "交周报"] },
  { text: "待办：买牛奶、交周报", items: ["买牛奶", "交周报"] },
  { text: "待办：买牛奶\n交周报", items: ["买牛奶", "交周报"] },
  { text: "添加待办：买牛奶", items: ["买牛奶"] },
  { text: "新建待办：明天复盘", items: ["明天复盘"] },
  { text: "列下待办 买牛奶", items: ["买牛奶"] },
  { text: "添加三条待办：买牛奶；交周报；预约体检", items: ["买牛奶", "交周报", "预约体检"] },
);

const noteCases: Array<{ text: string; body: string; literal: boolean }> = [];
for (const prefix of PREFIXES) {
  for (const verb of NOTE_VERBS) {
    for (const measure of NOTE_MEASURES) {
      noteCases.push(
        { text: `${prefix}${verb}${measure}便签：明天交周报`, body: "明天交周报", literal: true },
        { text: `${prefix}${verb}${measure}便签明天交周报`, body: "明天交周报", literal: false },
      );
    }
  }
}
noteCases.push(
  { text: "记一下明天交周报", body: "明天交周报", literal: false },
  { text: "记下来：明天交周报", body: "明天交周报", literal: false },
  { text: "记下明天交周报", body: "明天交周报", literal: false },
  { text: "记录一下明天交周报", body: "明天交周报", literal: false },
  { text: "记录明天交周报", body: "明天交周报", literal: false },
  { text: "便签：明天交周报", body: "明天交周报", literal: true },
  { text: "笔记: 明天交周报", body: "明天交周报", literal: true },
  { text: "便笺：明天交周报", body: "明天交周报", literal: true },
  { text: "帮我记个便签，内容是明天交周报", body: "明天交周报", literal: false },
  { text: "帮我记个便签：明天交周报。", body: "明天交周报。", literal: true },
  { text: "帮我记个便签：明天交周报！", body: "明天交周报！", literal: true },
  { text: "请帮我新建一张便笺，内容是：周五下午复盘。\n不要遗漏末行", body: "周五下午复盘。\n不要遗漏末行", literal: false },
);

const SIMPLE_COMMANDS: Array<[string, Action["type"]]> = [
  ["显示全部", "canvas.fit"], ["全部显示", "canvas.fit"], ["看全部", "canvas.fit"],
  ["适应画布", "canvas.fit"], ["fit", "canvas.fit"],
  ["恢复原视图", "canvas.restore"], ["恢复刚才的画面", "canvas.restore"], ["恢复视图", "canvas.restore"],
  ["退出聚焦", "canvas.restore"], ["取消聚焦", "canvas.restore"], ["restore", "canvas.restore"],
  ["唤醒", "stage.awaken"], ["唤醒一下", "stage.awaken"],
];
const simpleCases: Array<{ text: string; action: Action["type"] }> = [];
for (const prefix of PREFIXES) {
  for (const [command, action] of SIMPLE_COMMANDS) {
    for (const punctuation of SHORT_PUNCTUATION) {
      simpleCases.push({ text: `${prefix}${command}${punctuation}`, action });
    }
  }
}

const DELETE_PHRASES = [
  "删除所有卡片", "删掉全部卡片", "移除所有卡片",
  "删除当前画布所有卡片", "删除当前画布上的所有卡片", "删除画布上所有卡片",
  "清空画布", "清空当前画布", "清空所有卡片", "清空全部卡片",
  "把所有卡片删除", "把所有卡片都删除", "把全部卡片删掉",
  "把卡片全部删除", "把卡片都删除", "把卡片删除",
  "把当前画布清空", "把画布上的所有卡片清空",
];
const deleteCases: string[] = [];
for (const prefix of PREFIXES) {
  for (const phrase of DELETE_PHRASES) {
    for (const punctuation of SHORT_PUNCTUATION) deleteCases.push(`${prefix}${phrase}${punctuation}`);
  }
}

describe("countdown matrix: prefixes, verbs, measures, word order, numerals, punctuation", () => {
  it(`matches all ${countdownCases.length} variants in the fast rules`, () => {
    const failures: string[] = [];
    for (const { text, seconds } of countdownCases) {
      const hit = matchRules(text, emptyContext());
      const card = hit && created(hit.actions);
      if (!card || card.card.type !== "CountdownCard") { failures.push(`miss: ${text}`); continue; }
      const delta = Date.parse(String(card.card.sourceData.targetAt)) - Date.parse(String(card.card.sourceData.startedAt));
      if (Math.abs(delta - seconds * 1000) > 2) failures.push(`duration ${delta}ms != ${seconds}s: ${text}`);
    }
    expect(failures).toEqual([]);
  });

  it(`matches all ${countdownCases.length} variants in the decision-path contract`, () => {
    const failures: string[] = [];
    for (const { text, seconds } of countdownCases) {
      const slots = countdownContract.parse!(text, emptyContext());
      if (JSON.stringify(slots) !== JSON.stringify({ seconds })) failures.push(`${JSON.stringify(slots)} != ${seconds}: ${text}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("todo matrix: prefixes, verbs, measures, punctuation, multiline lists", () => {
  it(`matches all ${todoCases.length} variants in the fast rules`, () => {
    const failures: string[] = [];
    for (const { text, items } of todoCases) {
      const hit = matchRules(text, emptyContext());
      const card = hit && created(hit.actions);
      if (!card || card.card.type !== "TodoCard") { failures.push(`miss: ${text}`); continue; }
      const actual = (card.card.displayProps as { items?: Array<{ text: string }> }).items?.map(item => item.text);
      if (JSON.stringify(actual) !== JSON.stringify(items)) failures.push(`${JSON.stringify(actual)} != ${JSON.stringify(items)}: ${text}`);
    }
    expect(failures).toEqual([]);
  });

  it(`matches all ${todoCases.length} variants in the decision-path contract`, () => {
    const failures: string[] = [];
    for (const { text, items } of todoCases) {
      const slots = todoContract.parse!(text, emptyContext()) as { items?: string[] } | null;
      if (JSON.stringify(slots?.items) !== JSON.stringify(items)) failures.push(`${JSON.stringify(slots)} != ${JSON.stringify(items)}: ${text}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("note matrix: prefixes, verbs, measures, colon/no-colon, literal punctuation", () => {
  it(`matches all ${noteCases.filter(item => item.literal).length} explicit-colon variants in the fast rules`, () => {
    const failures: string[] = [];
    for (const { text, body } of noteCases.filter(item => item.literal)) {
      const hit = matchRules(text, emptyContext());
      const card = hit && created(hit.actions);
      if (!card || card.card.type !== "NoteCard") { failures.push(`miss: ${text}`); continue; }
      const actual = (card.card.displayProps as { text?: string }).text;
      if (actual !== body) failures.push(`${JSON.stringify(actual)} != ${JSON.stringify(body)}: ${text}`);
    }
    expect(failures).toEqual([]);
  });

  it(`matches all ${noteCases.length} variants in the decision-path contract`, () => {
    const failures: string[] = [];
    for (const { text, body } of noteCases) {
      const slots = noteContract.parse!(text, emptyContext()) as { text?: string } | null;
      if (slots?.text !== body) failures.push(`${JSON.stringify(slots)} != ${JSON.stringify(body)}: ${text}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("fixed-phrase matrix: fit/restore/awaken with prefixes and punctuation", () => {
  it(`matches all ${simpleCases.length} variants in the fast rules`, () => {
    const failures: string[] = [];
    for (const { text, action } of simpleCases) {
      const hit = matchRules(text, emptyContext());
      if (!hit?.actions.some(item => item.type === action)) failures.push(`miss ${action}: ${text}`);
    }
    expect(failures).toEqual([]);
  });

  it("matches fit and restore in the decision-path contracts", () => {
    const failures: string[] = [];
    for (const { text, action } of simpleCases) {
      if (action === "stage.awaken") continue;
      const slots = action === "canvas.fit" ? overviewContract.parse!(text, emptyContext()) : restoreContract.parse!(text, emptyContext());
      if (JSON.stringify(slots) !== "{}") failures.push(`miss ${action}: ${text}`);
    }
    expect(failures).toEqual([]);
  });

  it("accepts case-insensitive English aliases with punctuation", () => {
    for (const text of ["FIT", "Fit。", "RESTORE", "Restore！", " fit "]) {
      expect(matchRules(text, emptyContext())).not.toBeNull();
    }
  });
});

describe("delete-all matrix: prefixes, word order, punctuation, empty canvas", () => {
  it(`matches all ${deleteCases.length} variants when cards exist`, () => {
    const failures: string[] = [];
    for (const text of deleteCases) {
      const hit = matchRules(text, cardContext());
      const action = hit?.actions.find(item => item.type === "cards.delete");
      if (!action || action.type !== "cards.delete" || JSON.stringify(action.targetIds) !== JSON.stringify(["card-1"])) {
        failures.push(`miss or wrong target: ${text}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("defers delete-all when the canvas is empty instead of claiming success", () => {
    const failures = deleteCases.filter(text => matchRules(text, emptyContext()) !== null);
    expect(failures).toEqual([]);
  });
});

/** Real false positives found while building the matrix. Each string is a
 * complete request for something else, or an ambiguous colloquial phrase;
 * the deterministic layer must return null so the planner/splitter owns it. */
const DEFER = {
  countdown: [
    "倒计时", "帮我创建一个倒计时", "倒计时50", "倒计时0秒", "倒计时25小时",
    "倒计时30分钟然后显示全部", "倒计时30分钟，显示全部", "不要倒计时30分钟",
    "别设个30分钟倒计时", "如果下雨就倒计时30分钟", "解释一下倒计时30分钟",
    "倒计时30分钟是什么意思", "倒计时30分钟吗", "倒计时30分钟？", "把倒计时30分钟",
    "倒计时30分钟提醒我喝水", "倒计时30分钟，提醒我喝水", "30分钟倒计时提醒我喝水",
    "加待办：倒计时30分钟", "把30分钟倒计时删掉",
  ],
  todo: [
    "加待办：买牛奶；显示全部", "加待办：买牛奶；取消固定购物清单", "加待办：买牛奶；把书移到左边",
    "加待办：买牛奶；恢复原视图", "加待办：买牛奶；删除便签", "加待办：买牛奶。显示全部",
    "加待办：买牛奶。交周报", "加待办：买牛奶，然后显示全部", "加待办：买牛奶并创建便签",
    "加待办：买牛奶，别添加第二项", "加待办：如果我确认再添加买牛奶", "加待办：", "待办：；，",
    "待办：买牛奶，然后提醒我开会", "添加待办：买牛奶；再聚焦这张卡", "待办：买牛奶，取消聚焦",
    "待办：买牛奶；顺便打开浏览器", "待办：买牛奶再显示全部", "待办：买牛奶，如果下雨就不要创建",
    "待办：把这张便签改成完成", "加待办：买牛奶；移动卡片", "加待办：买牛奶；固定购物清单",
    "加待办：买牛奶；打开购物清单", "加待办：买牛奶；搜索明天天气", "加待办：买牛奶；查天气",
    "加待办：买牛奶；提醒我喝水", "加待办：买牛奶；倒计时5分钟", "加待办：买牛奶；设个5分钟计时器",
    "加待办：买牛奶；生成阅读计划卡", "加待办：买牛奶；创建一张周计划卡", "加待办：买牛奶；新建待办",
    "加待办：买牛奶；记个便签", "加待办：买牛奶；写便签", "加待办：买牛奶；把这张便签改成完成",
  ],
  note: [
    "帮我记个便签明天交周报，再设个50分钟倒计时", "记一下明天交周报，然后显示全部",
    "记一下明天交周报。显示全部", "记一下明天交周报。然后聚焦它", "帮我记个便签：买牛奶；显示全部",
    "帮我记个便签：买牛奶，然后显示全部", "帮我记个便签：买牛奶，再设个倒计时",
    "帮我记个便签：买牛奶，删除便签", "帮我记个便签：买牛奶，取消聚焦",
    "帮我记个便签：买牛奶，恢复原视图", "帮我记个便签：买牛奶，打开浏览器",
    "帮我记个便签：买牛奶，搜索天气", "帮我记个便签：买牛奶，提醒我喝水",
    "帮我记个便签：买牛奶，倒计时5分钟", "帮我记个便签：买牛奶，设个倒计时",
    "帮我记个便签：买牛奶，创建便签", "帮我记个便签：买牛奶，记一下",
    "帮我记个便签：买牛奶，生成报告", "帮我记个便签：买牛奶，聚焦它",
    "帮我记个便签：买牛奶，放大", "帮我记个便签：买牛奶，高亮",
    "帮我记个便签：买牛奶，移动", "帮我记个便签：买牛奶，固定",
    "帮我记个便签：买牛奶，暂停", "帮我记个便签：买牛奶，继续",
    "帮我记个便签：买牛奶，修改", "帮我记个便签：买牛奶，保存",
    "帮我记个便签：买牛奶，关闭", "帮我记个便签：买牛奶，查一下",
    "记一下", "便签：", "新建便笺，内容是", "创建便笺：", "帮我解释光合作用",
  ],
  simple: [
    "帮我显示全部然后删除这张卡", "显示全部？", "显示全部吗", "如何显示全部",
    "解释一下显示全部", "不要显示全部", "别显示全部", "如果显示全部",
    "显示全部是什么意思", "把显示全部", "恢复原视图然后显示全部",
    "恢复原视图，显示全部", "恢复原视图。显示全部", "帮我恢复原视图，再设个倒计时",
    "唤醒屏幕", "唤醒词", "唤醒我", "唤醒一下然后显示全部",
  ],
  delete: [
    "删除所有卡片中的一张", "删除所有卡片吗", "删除所有卡片？", "不要删除所有卡片",
    "别清空画布", "如果删除所有卡片", "解释删除所有卡片", "删除所有卡片然后显示全部",
    "删除所有卡片。显示全部", "清空画布后恢复", "清空画布，恢复原视图",
    "删除所有卡片；显示全部", "删除这张卡片", "删除所有", "清空", "全部删除",
    "删除所有卡", "删除所有卡片中的",
  ],
} as const;

describe("false positives: ambiguous or mixed requests must defer", () => {
  it("countdown", () => {
    const failures = DEFER.countdown.filter(text => matchRules(text, emptyContext()) !== null
      || countdownContract.parse!(text, emptyContext()) !== null);
    expect(failures).toEqual([]);
  });
  it("todo", () => {
    const failures = DEFER.todo.filter(text => matchRules(text, emptyContext()) !== null
      || todoContract.parse!(text, emptyContext()) !== null);
    expect(failures).toEqual([]);
  });
  it("note", () => {
    const failures = DEFER.note.filter(text => matchRules(text, emptyContext()) !== null
      || noteContract.parse!(text, emptyContext()) !== null);
    expect(failures).toEqual([]);
  });
  it("fixed phrases", () => {
    const failures = DEFER.simple.filter(text => matchRules(text, emptyContext()) !== null
      || overviewContract.parse!(text, emptyContext()) !== null
      || restoreContract.parse!(text, emptyContext()) !== null);
    expect(failures).toEqual([]);
  });
  it("delete-all", () => {
    const failures = DEFER.delete.filter(text => matchRules(text, cardContext()) !== null);
    expect(failures).toEqual([]);
  });
});

describe("simple sentence splitting", () => {
  it("splits independent operations after a full stop or semicolon", () => {
    expect(splitClauses("记个便签。设个倒计时。")).toEqual(["记个便签", "设个倒计时"]);
    expect(splitClauses("记个便签。再设个倒计时。")).toEqual(["记个便签", "设个倒计时"]);
    expect(splitClauses("加待办：买牛奶；显示全部")).toEqual(["加待办：买牛奶", "显示全部"]);
    expect(splitClauses("加待办：买牛奶；取消固定购物清单")).toEqual(["加待办：买牛奶", "取消固定购物清单"]);
  });
  it("does not split a note body or a timer follow-up after 然后", () => {
    expect(splitClauses("记个便签，然后明天交周报")).toEqual(["记个便签，然后明天交周报"]);
    expect(splitClauses("设个倒计时，然后十分钟后叫我")).toEqual(["设个倒计时，然后十分钟后叫我"]);
    expect(splitClauses("记一下明天交周报。明天也要交")).toEqual(["记一下明天交周报。明天也要交"]);
  });
});

describe("matrix coverage", () => {
  it("covers every generated surface and defer case", () => {
    const generated = countdownCases.length + todoCases.length + noteCases.length + simpleCases.length + deleteCases.length;
    const deferred = Object.values(DEFER).reduce((sum, list) => sum + list.length, 0);
    expect(generated).toBeGreaterThan(4_000);
    expect(deferred).toBeGreaterThan(100);
  });
});
