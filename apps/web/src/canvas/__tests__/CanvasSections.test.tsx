// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { CardState } from "@/state/canvasStore";
import { CanvasSections } from "../CanvasSections";
vi.mock("@xyflow/react", () => ({ ViewportPortal: ({ children }: { children: import("react").ReactNode }) => children }));
it("section labels use the same visible reminder membership as the actual canvas", async () => {
  const cards: CardState[] = ["due", "done", "far"].map((id, i) => ({ record: { id, type: "CountdownCard", variant: "standard", displayProps: {}, sources: [],
    layout: { x: i * 400, y: 60, width: 320, height: 180, pinned: false },
    metadata: { createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z", section: id },
    sourceData: { targetAt: new Date(Date.now() + (i === 2 ? 10000000 : 600000)).toISOString(), reminderText: id, ...(i === 1 ? { notifiedAt: "2026-10-24T00:00:00Z" } : {}) } } }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const div = document.createElement("div"), root = createRoot(div);
  try { await act(async () => root.render(<CanvasSections cards={cards} collapsed={new Set()} onToggle={() => {}} />));
    expect([...div.querySelectorAll('[data-space-section]')].map(e => e.getAttribute('data-space-section'))).toEqual(["due"]);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
