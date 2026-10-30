import { definitionKey, definitionRef, parsePackageFiles, type CardDefinition } from "@vivic/card-runtime";

export type OfficePlannerKind = "tasks" | "meeting" | "week";
export const OFFICE_PLANNER_CATALOG = [
  { kind: "tasks", id: "vivic.office-tasks", name: "工作推进卡", description: "把工作拆成行动，记录负责人、优先级和进展。", prompt: "用工作推进卡整理发布准备：我负责整理评审材料，周四下午截止，正在进行；确认反馈清单，待办；检查发布说明，周五截止。" },
  { kind: "meeting", id: "vivic.office-meeting", name: "会议行动卡", description: "从会议笔记提取结论与后续行动。", prompt: "用会议行动卡整理这些笔记：结论是先完善新手引导。我负责补全文案，下周一截止；同事甲核对截图，下周二截止，正在等待新版页面。" },
  { kind: "week", id: "vivic.office-week", name: "每周重点卡", description: "按星期安排重点，清楚看到完成与待推进。", prompt: "用每周重点卡整理本周：周一完成方案大纲，已经完成；周三评审交互稿，正在进行；周五整理周回顾，待办。" },
] as const;

// These are repository-owned JSON data, never an executable package entry point.
const bundledFiles = import.meta.glob<string>("../../../../../examples/card-packages/office-*/**/*.json", { eager: true, query: "?raw", import: "default" });
let definitionsPromise: Promise<CardDefinition[]> | undefined;
let knownDefinitions: readonly CardDefinition[] = [];

/** The normal package parser owns validation and hashes; no handwritten hash allowlist. */
export function loadBuiltinOfficeDefinitions(): Promise<CardDefinition[]> {
  definitionsPromise ??= Promise.all(OFFICE_PLANNER_CATALOG.map(async entry => {
    const marker = `/office-${entry.kind}/`;
    const files = Object.fromEntries(Object.entries(bundledFiles).filter(([path]) => path.includes(marker))
      .map(([path, text]) => [path.slice(path.indexOf(marker) + marker.length), text]));
    const definition = await parsePackageFiles(files);
    if (definition.manifest.id !== entry.id) throw new Error("办公卡片目录与包身份不一致");
    return definition;
  })).then(definitions => { knownDefinitions = definitions; return definitions; });
  return definitionsPromise;
}

/** Only an exact, parser-validated bundled definition can select a custom host view. */
export function officePlannerKind(definition: CardDefinition | undefined): OfficePlannerKind | undefined {
  if (!definition) return undefined;
  const index = knownDefinitions.findIndex(builtin => definitionKey(definitionRef(builtin)) === definitionKey(definitionRef(definition)));
  return index < 0 ? undefined : OFFICE_PLANNER_CATALOG[index]?.kind;
}
