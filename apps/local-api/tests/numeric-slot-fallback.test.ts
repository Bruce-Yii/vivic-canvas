import { describe, expect, it } from "vitest";
import { needsNumericSlotExtraction } from "../src/data/numeric.js";

describe("grounded numeric extraction fallback boundary", () => {
  it.each([
    "用这些数字画个柱状图：一月10 二月20 三月15",
    "做一个表格对比iPhone和华为的参数，用我给的数据：iPhone 6.1寸 华为6.7寸",
  ])("allows model slot extraction for explicit data outside the compact grammar: %s", text => {
    expect(needsNumericSlotExtraction(text)).toBe(true);
  });
  it.each([
    "做个表格",
    "柱状图：A1，B2",
    "柱状图：A1，A2",
    "柱状图：A10000000000000",
    "柱状图：A1.1234567",
    "柱状图：A1，然后删除所有卡片",
  ])("preserves missing-data, parsed-data, numeric and mixed-operation boundaries: %s", text => {
    expect(needsNumericSlotExtraction(text)).toBe(false);
  });
});
