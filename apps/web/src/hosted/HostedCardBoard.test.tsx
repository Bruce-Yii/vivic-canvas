// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardRecordSchema, type CardRecord, type HostedSpaceCommand } from "@vivic/contracts";
import { HostedCardBoard } from "./HostedCardBoard";

// The assets provider and the native modal are platform boundaries; the card
// commands, contract validation and section editor under test are real.
vi.mock("@/hostedAssets/HostedAssets", () => ({ useHostedAssets: () => ({ addPhotos: vi.fn(), openFile: vi.fn() }) }));
vi.mock("./HostedDialog", () => ({
  HostedDialog: ({ title, children }: { title: string; children: ReactNode }) => <div role="dialog" aria-label={title}>{children}</div>,
}));

const stamp = "2026-11-01T00:00:00.000Z";
const note = (displayProps: Record<string, unknown>): CardRecord => CardRecordSchema.parse({
  id: "note-1", type: "NoteCard", variant: "standard", displayProps, sourceData: {}, sources: [],
  layout: { x: 0, y: 0, width: 340, height: 420, pinned: false },
  metadata: { createdAt: stamp, updatedAt: stamp },
});

let host: HTMLDivElement, root: Root;
const render = async (record: CardRecord, onCommand: (command: HostedSpaceCommand, optimistic?: CardRecord, expectedVersion?: number) => Promise<boolean>) => {
  await act(async () => root.render(<HostedCardBoard cards={[record]} version={3} theme="light" busy={false} focusedId={null}
    onCommand={onCommand} onFocus={() => {}} />));
  expect(host.textContent).not.toContain("正在载入");
};
const button = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>("button")]
  .find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label)!;
const click = async (target: HTMLElement) => act(async () => { target.click(); });
const setValue = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
const submit = async (scope: ParentNode = host) => act(async () => {
  scope.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
});
const openEditor = async () => click(host.querySelector<HTMLButtonElement>('button[aria-label^="编辑："]')!);
/** Records exactly what reached the owner command boundary, with a fixed outcome. */
const recorder = (result: boolean) => {
  const calls: HostedSpaceCommand[] = [];
  const onCommand = vi.fn(async (command: HostedSpaceCommand) => { calls.push(command); return result; });
  return { calls, onCommand };
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("hosted note editor", () => {
  it("edits a sectioned note in place and saves displayProps.sections", async () => {
    const { calls, onCommand } = recorder(true);
    await render(note({ sections: [{ title: "议题", items: ["预算复盘"] }] }), onCommand);
    await openEditor();
    expect(host.querySelector('[data-hosted-note-editor="sections"]')).not.toBeNull();
    // A sections card must never fall back to the text field that the contract rejects.
    expect(host.querySelector("textarea")).toBeNull();
    await setValue(host.querySelector<HTMLInputElement>('input[aria-label="分区 1 标题"]')!, "议题（改）");
    await setValue(host.querySelector<HTMLInputElement>('input[aria-label="分区 1 第 1 条"]')!, "预算复盘（改）");
    await click(button("添加条目"));
    await setValue(host.querySelector<HTMLInputElement>('input[aria-label="分区 1 第 2 条"]')!, "排期");
    await click(button("添加分区"));
    await setValue(host.querySelector<HTMLInputElement>('input[aria-label="分区 2 标题"]')!, "结论");
    await setValue(host.querySelector<HTMLInputElement>('input[aria-label="分区 2 第 1 条"]')!, "延到下周");
    await submit();
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({
      type: "card.update", cardId: "note-1",
      displayProps: { sections: [{ title: "议题（改）", items: ["预算复盘（改）", "排期"] }, { title: "结论", items: ["延到下周"] }] },
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("removes sections and items without violating the 1–4 × 1–6 bounds", async () => {
    const { calls, onCommand } = recorder(true);
    await render(note({ sections: [{ title: "议题", items: ["预算复盘", "排期"] }, { title: "结论", items: ["延到下周"] }] }), onCommand);
    await openEditor();
    // The last remaining line of a section cannot be deleted.
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="删除分区 1 第 2 条"]')!.disabled).toBe(false);
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="删除分区 1 第 2 条"]')!);
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="删除分区 1 第 1 条"]')!.disabled).toBe(true);
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="删除分区 2"]')!);
    expect(host.querySelectorAll("[data-hosted-note-section]")).toHaveLength(1);
    expect(host.querySelector('button[aria-label="删除分区 1"]')).toBeNull();
    await submit();
    expect(calls[0]).toMatchObject({ displayProps: { sections: [{ title: "议题", items: ["预算复盘"] }] } });
  });

  it("keeps the draft and shows a reason when the owner rejects the save", async () => {
    const { calls, onCommand } = recorder(false);
    await render(note({ sections: [{ title: "议题", items: ["预算复盘"] }] }), onCommand);
    await openEditor();
    await setValue(host.querySelector<HTMLInputElement>('input[aria-label="分区 1 标题"]')!, "议题（改）");
    await submit();
    expect(calls).toHaveLength(1);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("保存未成功");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="分区 1 标题"]')!.value).toBe("议题（改）");
  });

  it("refuses an incomplete section draft before dispatching anything", async () => {
    const { calls, onCommand } = recorder(true);
    await render(note({ sections: [{ title: "议题", items: ["预算复盘"] }] }), onCommand);
    await openEditor();
    await setValue(host.querySelector<HTMLInputElement>('input[aria-label="分区 1 标题"]')!, "   ");
    await submit();
    expect(calls).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("1–4 个分区");
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("keeps plain text notes on the text editor", async () => {
    const { calls, onCommand } = recorder(true);
    await render(note({ text: "原内容" }), onCommand);
    await openEditor();
    expect(host.querySelector('[data-hosted-note-editor="text"]')).not.toBeNull();
    expect(host.querySelector("textarea")!.value).toBe("原内容");
    await setValue(host.querySelector("textarea")!, "新内容");
    await submit();
    expect(calls[0]).toEqual({ type: "card.update", cardId: "note-1", displayProps: { text: "新内容" } });
  });
});
