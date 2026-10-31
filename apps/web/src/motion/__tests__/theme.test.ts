import { describe, expect, it } from "vitest";
import { resolveTheme } from "../motionDirector";

// Local constructors intentionally exercise wall time, not a fixed UTC offset.
const local = (hour: number, minute: number, second = 0) => new Date(2026, 9, 15, hour, minute, second);

describe("scheduled Auto theme", () => {
  it.each([
    [6, 59, "dark"], [7, 0, "light"], [18, 59, "light"], [19, 0, "dark"], [23, 59, "dark"],
  ] as const)("legacy defaults resolve local %i:%i to %s", (hour, minute, expected) => {
    expect(resolveTheme("auto", local(hour, minute))).toBe(expected);
  });

  it.each([
    [7, 29, "dark"], [7, 30, "light"], [19, 44, "light"], [19, 45, "dark"],
  ] as const)("custom minute boundaries resolve local %i:%i to %s", (hour, minute, expected) => {
    expect(resolveTheme("auto", local(hour, minute, 59), { dayStart: "07:30", dayEnd: "19:45" })).toBe(expected);
  });

  it.each([
    [22, 14, "dark"], [22, 15, "light"], [23, 59, "light"], [0, 0, "light"], [6, 44, "light"], [6, 45, "dark"], [12, 0, "dark"],
  ] as const)("overnight daylight resolves local %i:%i to %s", (hour, minute, expected) => {
    expect(resolveTheme("auto", local(hour, minute), { dayStart: "22:15", dayEnd: "06:45" })).toBe(expected);
  });

  it("equal endpoints are an empty daylight interval", () => {
    for (const hour of [0, 7, 12, 23]) expect(resolveTheme("auto", local(hour, 0), { dayStart: "07:00", dayEnd: "07:00" })).toBe("dark");
  });

  it("omitted individual endpoints use their original defaults", () => {
    expect(resolveTheme("auto", local(8, 0), { dayStart: "09:00" })).toBe("dark");
    expect(resolveTheme("auto", local(18, 59), { dayStart: "09:00" })).toBe("light");
    expect(resolveTheme("auto", local(6, 59), { dayEnd: "10:00" })).toBe("dark");
    expect(resolveTheme("auto", local(7, 0), { dayEnd: "10:00" })).toBe("light");
    expect(resolveTheme("auto", local(10, 0), { dayEnd: "10:00" })).toBe("dark");
  });

  it("manual light/dark overrides the schedule at either time of day", () => {
    for (const theme of ["light", "dark"] as const) for (const hour of [0, 8, 20]) {
      expect(resolveTheme(theme, local(hour, 0), { dayStart: "22:15", dayEnd: "06:45" })).toBe(theme);
    }
  });

  it("malformed direct-call schedule values cannot produce invalid clock arithmetic", () => {
    expect(resolveTheme("auto", local(7, 0), { dayStart: "24:00", dayEnd: "19:99" })).toBe("light");
    expect(resolveTheme("auto", local(19, 0), { dayStart: "7:00", dayEnd: "" })).toBe("dark");
  });
});
