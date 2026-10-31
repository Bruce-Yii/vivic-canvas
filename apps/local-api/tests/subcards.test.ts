import { describe, expect, it } from "vitest";
import { ActionSchema, type Action } from "@vivic/contracts";
import { actionExecutionIssue } from "../src/intent/validation.js";
import { emptyContext } from "./helpers.js";

describe("subcards stay in the explicit owner editor", () => {
  const context = emptyContext([{ id: "TEST-todo", type: "TodoCard", displayProps: { items: [{ id: "TEST-item", text: "TEST 事项", done: false }] }, sourceDataSummary: {}, layout: { x: 0, y: 0 } }]);
  it.each<Action>([
    { type: "card.subcard.set", targetId: "TEST-todo", subcard: { id: "TEST-child", itemId: "TEST-item", text: "TEST 扩充" } },
    { type: "card.subcard.delete", targetId: "TEST-todo", subcardId: "TEST-child" },
  ])("accepts the shared UI contract but rejects model execution of $type", action => {
    expect(ActionSchema.safeParse(action).success).toBe(true);
    expect(actionExecutionIssue([action], context)).toContain("子卡片请通过控制端");
  });
});
