import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { CardRecord } from "../../src/contracts";
import { testCards } from "../../src/cards/__tests__/fixtures";
import { activeCanvasId, controlDispatch, openSpace } from "./helpers1";

// Synthetic TEST data only. No provider/key/microphone or future arrangeCanvas API.
const mixedCards = (): CardRecord[] => [
  { ...testCards.CountdownCard, layout: { x: 0, y: 0, width: 288, height: 96, pinned: false } },
  { ...testCards.TodoCard, layout: { x: 0, y: 0, width: 300, height: 80, pinned: false },
    displayProps: { items: Array.from({ length: 5 }, (_, i) => ({ id: `long-task-${i}`, text: `TEST ${i} ${"长待办需要换行并完整保留内容".repeat(9)}`, done: i === 1 })) } },
  { ...testCards.SearchResultCard, layout: { x: 0, y: 0, width: 520, height: 128, pinned: false },
    displayProps: { title: `TEST ${"长标题边界验证".repeat(18)}`, summary: `TEST ${"摘要内容需要在卡片内部收束".repeat(15)}`, sourceLabel: "TEST synthetic source" } },
  { ...testCards.WeatherCard, layout: { x: 0, y: 0, width: 180, height: 96, pinned: false } },
  { ...testCards.TableCard, layout: { x: 0, y: 0, width: 640, height: 176, pinned: false } },
  { ...testCards.ChartCard, layout: { x: 0, y: 0, width: 420, height: 240, pinned: false } },
  { ...testCards.NoteCard, variant: "expanded", layout: { x: 0, y: 0, width: 280, height: 72, pinned: false },
    displayProps: { text: Array.from({ length: 4 }, (_, i) => `TEST 第${i + 1}段 ${"多行笔记应保留换行和正文".repeat(7)}`).join("\n"),
      bullets: ["TEST 长条目 " + "笔记条目内容".repeat(20), "TEST 第二条 " + "更多正文".repeat(20)] } },
  { ...testCards.SearchResultCard, id: "TEST-pin-search", layout: { x: 0, y: 0, width: 720, height: 320, pinned: true } },
  { ...testCards.ChartCard, id: "TEST-pin-chart", layout: { x: -240, y: 950, width: 560, height: 360, pinned: true } },
];

const records = (page: Page) => page.evaluate(() => (window as unknown as {
  __vivic: { getState: () => { cards: Array<{ record: CardRecord; exitingRequestId?: string }> } };
}).__vivic.getState().cards.filter(card => !card.exitingRequestId).map(card => card.record));
const layoutMap = async (page: Page) => Object.fromEntries((await records(page)).map(record => [record.id, record.layout]));
const contents = (cards: CardRecord[]) => Object.fromEntries(cards.map(({ layout: _layout, ...record }) => [record.id, record]));

/** Actual painted bounds, including visible overflow, excluding clipped text.
 * In particular, a long title escaping a fixed-size card cannot pass merely
 * because the surrounding .vivic-card rectangle remains small.
 */
const auditGeometry = (page: Page) => page.locator("[data-card-id]").evaluateAll(elements => {
  type Rect = { left: number; right: number; top: number; bottom: number };
  const clip = (rect: Rect, element: Element, root: Element): Rect => {
    for (let ancestor: Element | null = element; ancestor && root.contains(ancestor); ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
      if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
        rect = { ...rect, left: Math.max(rect.left, box.left), right: Math.min(rect.right, box.right) };
      }
      if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
        rect = { ...rect, top: Math.max(rect.top, box.top), bottom: Math.min(rect.bottom, box.bottom) };
      }
    }
    return rect;
  };
  const cards = elements.map(root => {
    const box = root.getBoundingClientRect();
    const rect: Rect = { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    for (const child of root.querySelectorAll("*")) {
      const style = getComputedStyle(child);
      if (style.visibility === "hidden" || style.visibility === "collapse" || style.display === "none") continue;
      for (const bounds of child.getClientRects()) {
        const visible = clip({ left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }, child, root);
        if (visible.right <= visible.left || visible.bottom <= visible.top) continue;
        rect.left = Math.min(rect.left, visible.left); rect.right = Math.max(rect.right, visible.right);
        rect.top = Math.min(rect.top, visible.top); rect.bottom = Math.max(rect.bottom, visible.bottom);
      }
    }
    // Bare text inside a fixed-width block may overflow without enlarging
    // that block's client rect; include the actual rendered text fragments.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim() || getComputedStyle(parent).visibility === "hidden") continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const bounds of range.getClientRects()) {
        const visible = clip({ left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }, parent, root);
        if (visible.right <= visible.left || visible.bottom <= visible.top) continue;
        rect.left = Math.min(rect.left, visible.left); rect.right = Math.max(rect.right, visible.right);
        rect.top = Math.min(rect.top, visible.top); rect.bottom = Math.max(rect.bottom, visible.bottom);
      }
    }
    return { id: root.getAttribute("data-card-id"), ...rect, width: box.width, height: box.height };
  });
  const invalid = cards.filter(card => !card.id || card.width <= 0 || card.height <= 0 ||
    ![card.left, card.right, card.top, card.bottom].every(Number.isFinite)).map(card => card.id);
  const overlaps = [];
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i]!, b = cards[j]!;
    const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (width > 0.25 && height > 0.25) overlaps.push({ ids: [a.id, b.id], width, height });
  }
  const offscreen = cards.filter(card => card.left < -1 || card.top < -1 || card.right > innerWidth + 1 || card.bottom > innerHeight + 1).map(card => card.id);
  return { count: cards.length, invalid, overlaps, offscreen };
});
const expectDisjoint = async (page: Page, count: number, fitted = false) => {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // A single clear animation frame is insufficient: entry/fit animation or
  // a late browser measurement must not turn a transient clear frame into PASS.
  let consecutiveClearSamples = 0;
  await expect.poll(async () => {
    const audit = await auditGeometry(page);
    const clear = audit.count === count && audit.invalid.length === 0 && audit.overlaps.length === 0 && (!fitted || audit.offscreen.length === 0);
    consecutiveClearSamples = clear ? consecutiveClearSamples + 1 : 0;
    return { count: audit.count, invalid: audit.invalid, overlaps: audit.overlaps,
      ...(fitted ? { offscreen: audit.offscreen } : {}), stable: consecutiveClearSamples >= 3 };
  }, { message: "all real card/content rectangles must remain disjoint across measurements", timeout: 20000 }).toEqual({
    count, invalid: [], overlaps: [], ...(fitted ? { offscreen: [] } : {}), stable: true,
  });
};
const attachFailure = async (display: Page, testInfo: TestInfo) => {
  if (display.isClosed()) return;
  // Keep geometry and the actual painted result when a main-thread browser
  // regression fails; the project's config need not enable screenshots.
  await display.screenshot({ path: testInfo.outputPath("overlap-failure.png"), timeout: 5000 }).catch(() => undefined);
  const geometry = await auditGeometry(display).catch(error => ({ error: String(error) }));
  const cards = await records(display).catch(() => []);
  await testInfo.attach("overlap-failure.json", {
    body: JSON.stringify({ geometry, cards }, null, 2), contentType: "application/json",
  });
};
const fit = async (control: Page, display: Page, canvasId: string, tag: string, count: number) => {
  await controlDispatch(control, tag, canvasId, [{ type: "canvas.fit" }]);
  await expectDisjoint(display, count, true);
};
const expectPins = async (page: Page, fixtures: CardRecord[]) => {
  const current = await layoutMap(page);
  for (const pin of fixtures.filter(card => card.layout.pinned)) expect(current[pin.id], pin.id).toEqual(pin.layout);
};
const undo = async (control: Page) => {
  // Exercise the existing Control button, never a removed internal card.layout.
  await openSpace(control);
  await control.locator("[data-vivic-undo]").click();
};

test.describe("card overlap business invariants", () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 800, height: 600 }]) {
    test(`seven mixed card types, long content, pin obstacles, delete/undo and refresh at ${viewport.width}×${viewport.height}`, async ({ page, context }, testInfo) => {
      test.setTimeout(90000);
      await page.setViewportSize(viewport); await page.goto("/control");
      await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
      const canvasId = await activeCanvasId(page), fixtures = mixedCards();
      const display = await context.newPage(); await display.setViewportSize(viewport);
      try {
        await display.goto(`/display?canvasId=${encodeURIComponent(canvasId)}`);
        await controlDispatch(page, "TEST-overlap-seed", canvasId, [
          { type: "stage.awaken" }, ...fixtures.map(card => ({ type: "card.create", card })),
        ]);
        await expectDisjoint(display, fixtures.length);
        await fit(page, display, canvasId, "TEST-overlap-fit", fixtures.length);
        await expectPins(page, fixtures); await expectPins(display, fixtures);
        await expect(display.locator('[data-card-id="TEST-note"] [data-vivic-note-variant="expanded"]')).toHaveCount(1);
        await expect(display.locator('[data-card-id="TEST-todo"] [data-aui="checkbox"]')).toHaveCount(5);
        await expect(display.locator('[data-card-id="TEST-search"] [data-vivic-source-link]')).toBeVisible();
        const before = await records(page), originalTodo = before.find(card => card.id === "TEST-todo")!;

        await controlDispatch(page, "TEST-overlap-delete", canvasId, [{ type: "card.delete", targetId: originalTodo.id }]);
        await expect(display.locator('[data-card-id="TEST-todo"]')).toHaveCount(0);
        await expectDisjoint(display, fixtures.length - 1);
        await undo(page);
        await expect.poll(() => records(page)).toContainEqual(originalTodo);
        await expectDisjoint(display, fixtures.length);
        expect(contents(await records(page))).toEqual(contents(before));
        await expectPins(display, fixtures);
        await fit(page, display, canvasId, "TEST-overlap-undo-fit", fixtures.length);

        // Refill a deleted slot before undo: exact restoration must relocate
        // automatic survivors, rather than placing two cards in that slot.
        const originalNote = (await records(page)).find(card => card.id === "TEST-note")!;
        await controlDispatch(page, "TEST-overlap-delete-note", canvasId, [{ type: "card.delete", targetId: originalNote.id }]);
        await expect(display.locator('[data-card-id="TEST-note"]')).toHaveCount(0);
        const newcomer: CardRecord = { ...testCards.TableCard, id: "TEST-overlap-newcomer", layout: { x: 0, y: 0, width: 840, height: 420, pinned: false } };
        await controlDispatch(page, "TEST-overlap-refill", canvasId, [{ type: "card.create", card: newcomer }]);
        await expectDisjoint(display, fixtures.length);
        await undo(page);
        await expect.poll(() => records(page)).toContainEqual(originalNote);
        await expectDisjoint(display, fixtures.length + 1);
        await fit(page, display, canvasId, "TEST-overlap-refill-undo-fit", fixtures.length + 1);
        const expectedLayouts = await layoutMap(page), expectedContent = contents(await records(page));
        await expect.poll(() => layoutMap(display)).toEqual(expectedLayouts);
        await display.screenshot({ path: testInfo.outputPath("mixed-pinned-delete-undo.png") });

        // Verify both snapshot refresh and persistence/owner recovery.
        await display.reload(); await expectDisjoint(display, fixtures.length + 1);
        await expect.poll(() => layoutMap(display)).toEqual(expectedLayouts);
        expect(contents(await records(display))).toEqual(expectedContent);
        await page.reload();
        await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
        await expect.poll(() => layoutMap(page)).toEqual(expectedLayouts);
        await fit(page, display, canvasId, "TEST-overlap-owner-reload-fit", fixtures.length + 1);
        await expectPins(page, fixtures); await expectPins(display, fixtures);
        expect(contents(await records(page))).toEqual(expectedContent);
        await display.screenshot({ path: testInfo.outputPath("mixed-pinned-after-owner-refresh.png") });
        await testInfo.attach("final-layout.json", { body: JSON.stringify({ viewport, layouts: expectedLayouts, geometry: await auditGeometry(display) }, null, 2), contentType: "application/json" });
      } catch (error) {
        await attachFailure(display, testInfo).catch(() => undefined);
        throw error;
      } finally { await display.close(); }
    });
  }
  for (const type of ["TodoCard", "NoteCard"] as const) {
    test(`${type} growing after creation does not paint over the next row`, async ({ page, context }, testInfo) => {
      await page.goto("/control");
      await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
      const canvasId = await activeCanvasId(page);
      const short: CardRecord = type === "TodoCard"
        ? { ...testCards.TodoCard, id: "TEST-growing", layout: { x: 0, y: 0, width: 260, height: 120, pinned: false }, displayProps: { items: [{ id: "short", text: "TEST short", done: false }] } }
        : { ...testCards.NoteCard, id: "TEST-growing", variant: "expanded", layout: { x: 0, y: 0, width: 260, height: 120, pinned: false }, displayProps: { text: "TEST short" } };
      const neighbors = Array.from({ length: 3 }, (_, i) => ({ ...testCards.WeatherCard, id: `TEST-growth-neighbor-${i}` }));
      const pin: CardRecord = { ...testCards.SearchResultCard, id: "TEST-growth-pin", layout: { x: -400, y: 0, width: 280, height: 320, pinned: true } };
      const display = await context.newPage(); await display.setViewportSize({ width: 800, height: 600 });
      try {
        await display.goto(`/display?canvasId=${encodeURIComponent(canvasId)}`);
        await controlDispatch(page, `TEST-growth-seed-${type}`, canvasId, [
          { type: "stage.awaken" }, ...[short, ...neighbors, pin].map(card => ({ type: "card.create", card })),
        ]);
        await expectDisjoint(display, 5);
        const longer = mixedCards().find(card => card.type === type)!;
        await controlDispatch(page, `TEST-growth-update-${type}`, canvasId, [{ type: "card.update", targetId: short.id, displayProps: longer.displayProps }]);
        await expect.poll(async () => (await records(display)).find(card => card.id === short.id)?.displayProps).toEqual(longer.displayProps);
        await fit(page, display, canvasId, `TEST-growth-fit-${type}`, 5);
        await expectPins(display, [pin]);
        const expected = await layoutMap(page);
        await display.reload(); await expectDisjoint(display, 5);
        await expect.poll(() => layoutMap(display)).toEqual(expected);
        await display.screenshot({ path: testInfo.outputPath(`grown-${type}-after-refresh.png`) });
      } catch (error) {
        await attachFailure(display, testInfo).catch(() => undefined);
        throw error;
      } finally { await display.close(); }
    });
  }

});
