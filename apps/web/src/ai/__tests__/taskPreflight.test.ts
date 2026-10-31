// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema, type Action, type ActionEnvelope } from "@/contracts";
import { testCards } from "@/cards/__tests__/fixtures";
import { buildSceneFixtures } from "@/cards/scene/fixtures";
import { taskPreflight } from "../taskPreflight";
import { runDecisionTask } from "../decisionTask";
import type { postIntent } from "../api";
import { createMemoryDB } from "@/persistence/db";
import { createMemoryHub } from "@/sync/channel";
import { createMemoryLockProvider } from "@/sync/testing";
import { createControlHost, type ControlHost } from "@/sync/controlHost";
import { createCanvasStore } from "@/state/canvasStore";

const records = [testCards.NoteCard, testCards.TodoCard];
const envelope = (actions: Action[], canvasId = "TEST-space"): ActionEnvelope => ({ schemaVersion:"0.6",requestId:"TEST-proposal",canvasId,actions });
const good: Action = {type:"card.update",targetId:testCards.NoteCard.id,displayProps:{text:"TEST updated"}};
const invalid: Array<{name:string;action:Action}> = [
  {name:"non-note density",action:{type:"card.update",targetId:testCards.TodoCard.id,variant:"expanded"}},
  {name:"density mixed with text",action:{...good,variant:"minimal"}},
  {name:"density mixed with source",action:{type:"card.update",targetId:testCards.NoteCard.id,variant:"expanded",sourceData:{detail:"replace"}}},
  {name:"empty update",action:{type:"card.update",targetId:testCards.NoteCard.id}},
  {name:"invalid merged record",action:{type:"card.update",targetId:testCards.TodoCard.id,displayProps:{items:"not a list"}}},
  {name:"missing todo item",action:{type:"card.highlight",targetId:testCards.TodoCard.id,itemId:"missing"}},
  {name:"unsupported item family",action:{type:"card.highlight",targetId:testCards.NoteCard.id,itemId:"line:1"}},
  {name:"subcard deletion",action:{type:"card.subcard.delete",targetId:testCards.NoteCard.id,subcardId:"subcard"}},
  {name:"subcard creation",action:{type:"card.subcard.set",targetId:testCards.NoteCard.id,subcard:{id:"subcard",text:"TEST"}}},
  {name:"empty subtitle",action:{type:"subtitle.show",text:"   "}},
  {name:"canvas routing",action:{type:"canvas.switch",canvasId:"another"}},
];
const stops:ControlHost[]=[];
afterEach(()=>{stops.splice(0).forEach(host=>host.stop());vi.restoreAllMocks();});

describe("complete task batch preflight",()=>{
  it.each(invalid)("rejects $name before either order of a mixed batch mutates its input",({action})=>{
    const before=structuredClone(records);
    expect(ActionEnvelopeSchema.safeParse(envelope([good,action])).success).toBe(true);
    expect(taskPreflight(envelope([good,action]),records)).not.toBeNull();
    expect(taskPreflight(envelope([action,good]),records)).not.toBeNull();
    expect(records).toEqual(before);
  });
  it("rejects both supported-schema subcard actions explicitly",()=>{
    for(const {action} of invalid.filter(test=>test.name.startsWith("subcard"))) expect(taskPreflight(envelope([action]),records)).toContain("子卡片");
  });
  it("tracks deleted and updated targets in action order and never recycles an ID",()=>{
    expect(taskPreflight(envelope([{type:"card.delete",targetId:testCards.NoteCard.id},good]),records)).not.toBeNull();
    expect(taskPreflight(envelope([{type:"cards.delete",targetIds:[testCards.NoteCard.id,"missing"]}]),records)).not.toBeNull();
    expect(taskPreflight(envelope([{type:"card.delete",targetId:testCards.NoteCard.id},{type:"card.create",card:testCards.NoteCard}]),records)).not.toBeNull();
    expect(taskPreflight(envelope([{type:"card.update",targetId:testCards.TodoCard.id,displayProps:{items:[{id:"new-item",text:"new",done:false}]}},{type:"card.highlight",targetId:testCards.TodoCard.id,itemId:"TEST-task"}]),records)).toContain("条目");
  });
  it("permits supported density, new-card editing, and current todo-item highlighting",()=>{
    expect(taskPreflight(envelope([{type:"card.update",targetId:testCards.NoteCard.id,variant:"expanded"}]),records)).toBeNull();
    const card={...testCards.NoteCard,id:"TEST-new"};
    expect(taskPreflight(envelope([{type:"card.create",card},{type:"card.update",targetId:card.id,displayProps:{text:"new content"}},{type:"card.focus",targetId:card.id}]),records)).toBeNull();
    expect(taskPreflight(envelope([{type:"card.highlight",targetId:testCards.TodoCard.id,itemId:"TEST-task"}]),records)).toBeNull();
  });
  it("rejects a user-surface focus and preserves service facts while accepting personal notes",()=>{
    expect(taskPreflight(envelope([{type:"card.focus",targetId:testCards.NoteCard.id}]),[{...testCards.NoteCard,layout:{...testCards.NoteCard.layout,surface:"user"}}])).not.toBeNull();
    const travel=buildSceneFixtures().travel_offers;
    expect(taskPreflight(envelope([good,{type:"card.update",targetId:travel.id,displayProps:{mode:"live"}}]),[...records,travel])).toContain("只读");
    expect(taskPreflight(envelope([{type:"card.update",targetId:travel.id,displayProps:{notes:"my note"}}]),[travel])).toBeNull();
  });
  it("sends a failure receipt without dispatching a valid first action when a later action would be silently ignored",async()=>{
    const store=createCanvasStore(),host=createControlHost({db:createMemoryDB(),store,channel:createMemoryHub().createChannel(),lockProvider:createMemoryLockProvider(),reminderPollMs:1e6});
    stops.push(host);await host.start();
    const canvasId=host.getSnapshot().activeCanvasId!;
    expect(host.dispatch(envelope(records.map(card=>({type:"card.create" as const,card})),canvasId)).ok).toBe(true);
    const before=store.getState(), dispatch=vi.spyOn(host,"dispatch"), flush=vi.spyOn(host,"flush");
    const task={protocolVersion:"vivic-decision-v2" as const,id:"TEST-task",step:1,decision:"native-v2" as const};
    const request=vi.fn<typeof postIntent>()
      .mockResolvedValueOnce({kind:"envelope",envelope:envelope([good,invalid[0]!.action],canvasId),task:{...task,status:"awaiting_execution",executionId:"TEST-execution"}})
      .mockResolvedValueOnce({kind:"error",message:"rejected",task:{...task,status:"failed"}});
    const result=await runDecisionTask({host,store,text:"TEST",taskId:task.id,signal:new AbortController().signal,isCurrent:()=>true,request});
    expect(result.executed).toBe(false);expect(dispatch).not.toHaveBeenCalled();expect(flush).not.toHaveBeenCalled();expect(store.getState()).toBe(before);
    expect(request.mock.calls[1]![7]).toMatchObject({receipt:{executionId:"TEST-execution",status:"failed"}});
  });
});
