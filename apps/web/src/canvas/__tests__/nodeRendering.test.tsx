// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VivicNode } from "../CanvasView";
import { createNodeDataMemo } from "../nodeData";
import { relayout, type CardState } from "@/state/canvasStore";
import { testCards } from "@/cards/__tests__/fixtures";

const rendered = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("@/cards/VivicCard", () => ({ VivicCard: ({ record }: { record: { id: string } }) => {
  rendered.ids.push(record.id);
  return <span>{record.id}</span>;
} }));
vi.mock("@/cards/SubcardAnchor", () => ({ SubcardAnchor: () => null }));
vi.mock("@/cards/TargetBadge", () => ({ TargetBadge: () => null }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container); rendered.ids = [];
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("does not render chart content on pointer moves or when a neighboring note changes", async () => {
  const memoData = createNodeDataMemo();
  let entries: CardState[] = relayout([{ record: testCards.ChartCard }, { record: testCards.NoteCard }]);
  const draw = async (dragX: number) => act(() => root.render(<>{entries.map(entry => <VivicNode
    key={entry.record.id} id={entry.record.id} type="vivic" dragging={dragX > 0} draggable selectable={false}
    deletable={false} selected={false} isConnectable={false} positionAbsoluteX={dragX} positionAbsoluteY={0} zIndex={0}
    data={memoData({ entry, focused: false, dimmed: false, highlight: null })}
  />)}</>));
  await draw(0);
  expect(rendered.ids).toEqual([testCards.ChartCard.id, testCards.NoteCard.id]);
  rendered.ids = [];
  await draw(10); await draw(30);
  expect(rendered.ids).toEqual([]);
  entries = relayout(entries.map(entry => entry.record.type === "NoteCard"
    ? { record: { ...entry.record, displayProps: { text: "changed" } } } : entry));
  await draw(30);
  expect(rendered.ids).toEqual([testCards.NoteCard.id]);
  expect(container.textContent).toContain(testCards.ChartCard.id);
});
