// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CardRecordSchema, type CardRecord } from "@/contracts";
import { VivicCard } from "../VivicCard";
import type { ChartCard, WeatherCard } from "../dataCardTypes";
import { testCards } from "./fixtures";

// Stub the browser's layout/observer boundary only; render the REAL approved
// registry and Recharts components so tests can catch missing/malformed marks.
class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  targets = new Set<Element>();
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    TestResizeObserver.instances.push(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  resize(width: number, height: number) {
    const entries = [...this.targets].map(target => ({ target, contentRect: { width, height } }) as ResizeObserverEntry);
    if (entries.length) this.callback(entries, this as unknown as ResizeObserver);
  }
}

let host: HTMLDivElement;
let root: Root;
const render = async (node: ReactNode) => {
  await act(async () => {
    root.render(node);
    await Promise.all([import("../ChartCardView"), import("../scene/views/TravelOffersCardView"), import("@/extensions/ExtensionCardView")]);
  });
  expect(host.textContent).not.toContain("正在加载卡片…");
};
const chart = (chartKind: ChartCard["displayProps"]["chartKind"], points: ChartCard["displayProps"]["points"] = testCards.ChartCard.displayProps.points): ChartCard => ({
  ...testCards.ChartCard, displayProps: { ...testCards.ChartCard.displayProps, chartKind, points },
});

beforeAll(async () => {
  await Promise.all([import("../ChartCardView"), import("../scene/views/TravelOffersCardView"), import("@/extensions/ExtensionCardView")]);
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  TestResizeObserver.instances = [];
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("recharts-responsive-container")
      ? { x: 0, y: 0, width: 320, height: 208, top: 0, right: 320, bottom: 208, left: 0, toJSON: () => ({}) }
      : rect.call(this);
  });
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

describe("data card renderers", () => {
  it("renders all seven validated registry types without adding frames or controls", async () => {
    const records = Object.values(testCards).filter(record => record.type !== "ExtensionCard" && record.type !== "FileCard").map(record => CardRecordSchema.parse(record));
    await render(<>{records.map(record => <section key={record.id} data-test-type={record.type}><VivicCard record={record} /></section>)}</>);
    for (const record of records) {
      expect(host.querySelector(`[data-test-type="${record.type}"]`)?.childElementCount).toBeGreaterThan(0);
    }
    expect(host.querySelector(".recharts-line-curve")).not.toBeNull();
    expect(host.querySelector(".vivic-card")).toBeNull();
    expect(host.querySelector("button")).toBeNull();
  });

  it.each<WeatherCard["displayProps"]["conditionIcon"]>(["sun", "cloud", "rain", "snow", "wind", "fog", "storm", "night"])("weather %s is only the exact temperature and an accessible Lucide icon", async conditionIcon => {
    await render(<VivicCard record={{ ...testCards.WeatherCard, displayProps: { tempC: -3.5, conditionIcon } }} />);
    expect(host.textContent).toBe("-3.5°C");
    expect(host.querySelectorAll("svg.lucide[role=img][aria-label]")).toHaveLength(1);
    expect(host.querySelector("[data-aui=row]")).not.toBeNull();
  });

  it.each([NaN, Infinity, -Infinity, 66, -101])("weather does not turn invalid temperature %s into a real reading", async tempC => {
    await render(<VivicCard record={{ ...testCards.WeatherCard, displayProps: { tempC, conditionIcon: "snow" } }} />);
    expect(host.textContent).toBe("—");
  });

  it("maps table columns and cells without losing zero, false, signed numbers, or null", async () => {
    await render(<VivicCard record={testCards.TableCard} />);
    expect([...host.querySelectorAll("th")].map(cell => cell.textContent)).toEqual(["TEST item", "TEST value", "TEST state"]);
    expect([...host.querySelectorAll("tbody tr")].map(row => [...row.querySelectorAll("td")].map(cell => cell.textContent))).toEqual([
      ["TEST same", "0", "false"], ["TEST same", "-5.25", "—"], ["TEST third", "8", "true"],
    ]);
    expect(host.querySelector('[data-aui="table"]')).not.toBeNull();
    expect(host.querySelector("button")).toBeNull();
  });

  it("keeps row:2 tied to original position despite duplicate text, data updates, and highlight clearing", async () => {
    const record = testCards.TableCard;
    const highlight = { id: "TEST-highlight", cardId: record.id, itemId: "row:2", durationMs: 3000 };
    await render(<VivicCard record={record} highlight={highlight} />);
    expect(host.querySelectorAll("tbody [data-vivic-highlighted]")).toHaveLength(1);
    expect(host.querySelector('[data-vivic-row-id="row:2"]')?.getAttribute("data-vivic-highlighted")).toBe("true");
    await render(<VivicCard record={{ ...record, displayProps: { ...record.displayProps, rows: [["TEST updated", 2, false], ...record.displayProps.rows.slice(1)] } }} highlight={highlight} />);
    expect(host.querySelector("tbody [data-vivic-highlighted]")?.getAttribute("data-vivic-row-id")).toBe("row:2");
    await render(<VivicCard record={record} highlight={{ ...highlight, cardId: "TEST-other" }} />);
    expect(host.querySelector("tbody [data-vivic-highlighted]")).toBeNull();
    await render(<VivicCard record={record} highlight={{ ...highlight, itemId: "row:99" }} />);
    expect(host.querySelector("tbody [data-vivic-highlighted]")).toBeNull();
    await render(<VivicCard record={record} highlight={highlight} />);
    await render(<VivicCard record={record} />);
    expect(host.querySelector("[aria-current]")).toBeNull();
  });

  it("keeps ragged or nonfinite table cells missing and bounds the actual styled table", async () => {
    await render(<VivicCard record={{ ...testCards.TableCard, displayProps: { columns: ["TEST A", "TEST B"], rows: [["<script>TEST</script>"], [NaN, Infinity], [false, 0, "TEST undeclared"]] } }} />);
    expect([...host.querySelectorAll("tbody tr")].map(row => row.children.length)).toEqual([2, 2, 2]);
    expect([...host.querySelectorAll("tbody td")].map(cell => cell.textContent)).toEqual(["<script>TEST</script>", "—", "—", "—", "false", "0"]);
    expect(host.querySelector("script")).toBeNull();
    expect((host.querySelector("[data-vivic-data-table]") as HTMLElement).style.maxHeight).toBe("198px");
  });

  it.each(["line", "bar", "pie"] as const)("renders real %s marks and survives initial, zero, narrow, and recovered widths without size warnings", async kind => {
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const record = chart(kind, [{ x: "TEST A", y: 2 }, { x: "TEST B", y: 6 }]);
    await render(<VivicCard record={record} />);
    const selector = kind === "line" ? ".recharts-line-curve" : kind === "bar" ? ".recharts-bar-rectangle path" : ".recharts-pie-sector path";
    expect(host.querySelector(selector)).not.toBeNull();
    expect(host.textContent).toContain("TEST units");
    if (kind !== "pie") expect(host.textContent).toContain("TEST sample");
    expect(host.querySelector(".recharts-legend-wrapper")).toBeNull();
    for (const width of [0, 48, 480]) {
      await act(async () => TestResizeObserver.instances.forEach(observer => observer.resize(width, 0)));
      if (width > 0) expect(host.querySelector("svg.recharts-surface")?.getAttribute("width")).toBe(String(width));
    }
    expect(host.querySelector(selector)).not.toBeNull();
    expect(host.innerHTML).not.toMatch(/(?:NaN|Infinity)/);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/width|height|greater than 0/i);
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/NaN|Infinity|width|height/i);
  });

  it("keeps numeric x spacing and signed y values instead of treating every x as a category", async () => {
    const record = chart("line", [{ x: 0, y: -5 }, { x: 1, y: 0 }, { x: 10, y: 5 }]);
    await render(<VivicCard record={record} />);
    const dots = [...host.querySelectorAll(".recharts-line-dot")];
    const xs = dots.map(dot => Number(dot.getAttribute("cx")));
    expect(xs).toHaveLength(3);
    expect((xs[2]! - xs[1]!) / (xs[1]! - xs[0]!)).toBeCloseTo(9);
    expect(Number(dots[0]!.getAttribute("cy"))).toBeGreaterThan(Number(dots[2]!.getAttribute("cy")));
    expect(record.displayProps.points[0]!.y).toBe(-5);
  });

  it.each([[-2, 6], [0, 0], [-2, -6]])("pie %j uses original values in a styled table, without abs/clamping/dropping", async (a, b) => {
    const record = chart("pie", [{ x: "TEST A", y: a }, { x: "TEST B", y: b }]);
    const before = structuredClone(record);
    await render(<VivicCard record={record} />);
    expect(host.querySelector(".recharts-pie")).toBeNull();
    expect([...host.querySelectorAll("tbody tr")].map(row => row.lastElementChild?.textContent)).toEqual([String(a), String(b)]);
    expect(record).toEqual(before);
  });

  it("falls back for invalid/overflow chart values without supplying invented points", async () => {
    for (const points of [[{ x: "TEST missing", y: NaN }], [{ x: "TEST A", y: -1e308 }, { x: "TEST B", y: 1e308 }]]) {
      await render(<VivicCard record={chart("line", points)} />);
      expect(host.querySelector("[data-vivic-chart-fallback]")).not.toBeNull();
      expect(host.querySelectorAll("tbody tr")).toHaveLength(points.length);
      expect(host.querySelector("svg")).toBeNull();
    }
    await render(<VivicCard record={chart("line", [])} />);
    expect(host.textContent).toBe("—");
  });

  it("renders only selected displayProps and expands Note only through its stored variant", async () => {
    for (const record of Object.values(testCards).filter(card => card.type !== "FileCard") as CardRecord[]) {
      await render(<VivicCard record={record} />);
      expect(host.textContent).not.toMatch(/hidden location|hidden source data|TEST \/ DEMO source/);
      expect(host.querySelector("button")).toBeNull();
    }
    await render(<VivicCard record={testCards.NoteCard} />);
    expect(parseFloat((host.firstElementChild as HTMLElement).style.maxHeight)).toBeGreaterThan(0);
    expect(parseFloat((host.firstElementChild as HTMLElement).style.maxHeight)).toBeLessThanOrEqual(testCards.NoteCard.layout.height - 32);
    await render(<VivicCard record={{ ...testCards.NoteCard, variant: "expanded" }} />);
    expect((host.firstElementChild as HTMLElement).style.maxHeight).toBe("");
    expect(host.textContent).toContain("TEST fourth line");
    expect(host.textContent).toContain("TEST bullet two");
    expect(host.querySelector("button")).toBeNull();
  });
});
