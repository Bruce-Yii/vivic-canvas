import { it, expect } from "vitest";
import { HostOperationSchema } from "@vivic/contracts";
import { exactHostOperation } from "../src/decision/hostOperations";
it("exact explicit ambient, history and preview commands use bounded host operations", () => {
  expect(exactHostOperation("暂停背景动画")).toEqual({ kind: "ambient.control", mode: "off" });
  expect(exactHostOperation("光柔和一点")).toEqual({ kind: "ambient.control", mode: "soft" });
  expect(exactHostOperation("重做")).toEqual({ kind: "history.redo" });
  expect(exactHostOperation("按优先级排序")).toEqual({ kind: "canvas.organize.preview", sort: "priority", direction: "asc", group: "keep" });
  expect(exactHostOperation("按日期分区")).toEqual({ kind: "canvas.organize.preview", sort: "manual", direction: "asc", group: "date" });
});
it.each(["不要关闭光效", "解释重做", "他说：暂停背景动画", "按日期分区，然后删除所有卡片", "把光效开到999", "不是重做"])("does not execute quoted, negated or composite input: %s", text => {
  expect(exactHostOperation(text)).toBeNull();
});
it("does not accept extra executable fields or invalid ambient choices", () => {
  expect(HostOperationSchema.safeParse({ kind: "ambient.control", mode: "off", command: "anything" }).success).toBe(false);
  expect(HostOperationSchema.safeParse({ kind: "ambient.control", mode: "unknown" }).success).toBe(false);
});
