import { describe, expect, it } from "vitest";
import { DEFAULT_INPUT, STORAGE_KEY, TripInputSchema, budgetAllocation, generateTrip, readTrip, updateTripCard, writeTrip } from "./model";
describe("isolated travel host", () => {
  it("builds editable days and validated DEMO results without prices or booking claims", async () => {
    const trip = await generateTrip(DEFAULT_INPUT, { delayMs: 0 });
    expect(trip.days).toHaveLength(3); expect(trip.offers.displayProps.mode).toBe("demo");
    expect(trip.offers.displayProps.items).toHaveLength(3);
    expect(trip.offers.displayProps.items.every(item => !item.price && !item.detailUrl && !item.rating)).toBe(true);
  });
  it("allows user notes/selections but rejects forged facts, sources and unknown selection", async () => {
    const trip = await generateTrip(DEFAULT_INPUT, { delayMs: 0 });
    expect(updateTripCard(trip, trip.offers.id, { displayProps: { notes: "想住安静一点" } })?.offers.displayProps.notes).toBe("想住安静一点");
    expect(updateTripCard(trip, trip.offers.id, { displayProps: { mode: "live" } })).toBeNull();
    expect(updateTripCard(trip, trip.offers.id, { sourceData: { provider: "fliggy" } })).toBeNull();
    expect(updateTripCard(trip, trip.offers.id, { displayProps: { selectedIds: ["unknown"] } })).toBeNull();
    expect(updateTripCard(trip, trip.comparison.id, { displayProps: { criteria: [] } })).toBeNull();
  });
  it("preserves valid selection and notes on same destination replan; clears invalid empty selections", async () => {
    let trip = await generateTrip(DEFAULT_INPUT, { delayMs: 0 });
    trip = updateTripCard(trip, trip.offers.id, { displayProps: { selectedIds: ["demo-walk"], notes: "我的备注" } })!;
    const next = await generateTrip({ ...DEFAULT_INPUT, budget: 3600 }, { previous: trip, delayMs: 0 });
    expect(next.offers.displayProps.selectedIds).toEqual(["demo-walk"]); expect(next.offers.displayProps.notes).toBe("我的备注");
    const empty = await generateTrip(DEFAULT_INPUT, { previous: next, scenario: "empty", delayMs: 0 });
    expect(empty.offers.displayProps.status).toBe("empty"); expect(empty.offers.displayProps.selectedIds).toEqual([]);
  });
  it("rejects cancellation and error without returning partial cards", async () => {
    const controller = new AbortController();
    const pending = generateTrip(DEFAULT_INPUT, { signal: controller.signal, delayMs: 30 }); controller.abort();
    await expect(pending).rejects.toThrow();
    await expect(generateTrip(DEFAULT_INPUT, { scenario: "error", delayMs: 0 })).rejects.toThrow();
  });
  it("validates input bounds and computes exact budget total", () => {
    expect(TripInputSchema.safeParse({ ...DEFAULT_INPUT, days: 8 }).success).toBe(false);
    expect(TripInputSchema.safeParse({ ...DEFAULT_INPUT, destination: " " }).success).toBe(false);
    expect(budgetAllocation(2379).reduce((total, item) => total + item.amount, 0)).toBe(2379);
  });
  it("isolates persistence key, restores edits, rejects corrupt saved data and reports storage failures", async () => {
    const values = new Map<string, string>([["vivic.owner", "private"]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const trip = await generateTrip(DEFAULT_INPUT, { delayMs: 0 });
    expect(writeTrip(storage, trip)).toBe(true); expect(readTrip(storage).trip?.days.length).toBe(3);
    writeTrip(storage, null); expect(values.get("vivic.owner")).toBe("private"); expect(values.has(STORAGE_KEY)).toBe(false);
    values.set(STORAGE_KEY, '{"bad":true}'); expect(readTrip(storage).warning).toBeTruthy();
    expect(writeTrip({ ...storage, setItem: () => { throw Error("quota"); } }, trip)).toBe(false);
  });
});
