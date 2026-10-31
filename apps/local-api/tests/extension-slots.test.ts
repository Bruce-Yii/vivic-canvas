import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { parsePackageFiles, type CardDefinition } from "@vivic/card-runtime";
import { readPackageDirectory } from "../../../packages/card-runtime/src/nodeFiles.js";
import { runSlotPlanner } from "../src/intent/slotPlanner.js";
import { buildAllSceneActions } from "../src/scenes/extensions.js";
import type { CanvasContext } from "../src/schemas.js";

const ctx: CanvasContext = { canvasId: "TEST-extension", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] };
const time = new Date("2026-10-30T04:00:00.000Z");
afterEach(() => vi.useRealTimers());
const fixture = async () => parsePackageFiles(await readPackageDirectory(resolve("../../examples/vivicard/fitness-log")));
function setup(def: CardDefinition, outputs: unknown[]) {
  let index=0;const id=`ext.${def.manifest.id}`;
  const generate=vi.fn(async()=>({ok:true as const,value:outputs[Math.min(index++,outputs.length-1)]}));
  const deps={definitions:[def],usedProvider:"stepfun" as const,hint:Promise.resolve({result:{route:id as `ext.${string}`,probability:.99,probabilities:{[id]:.99},none:false,latencyMs:1},target:Promise.resolve(undefined)}),
    generate,isCurrent:()=>true,lookup:async()=>({kind:"error" as const,message:"TEST lookup forbidden"})};
  return {deps,generate,id};
}
const data={trainingDate:"2026-10-30",bodyPart:"背",minutes:40};
const full={config:{title:"训练记录"},data,state:{note:""}};
describe("installed extension slots use host-built records and real facts",()=>{
  it.each(["flat","triple"])("builds a grounded record from %s parameters without copying DEMO state",async format=>{
    vi.useFakeTimers();vi.setSystemTime(time);const def=await fixture(),f=setup(def,[{slots:format==="flat"?data:full,say:"已记下训练。",text:"已保存健身记录。"}]);
    const r=await runSlotPlanner({text:"今天练了40分钟背",canvasContext:ctx},f.deps);
    expect(r.kind,JSON.stringify(r)).toBe("envelope");const action=r.envelope!.actions.find(a=>a.type==="card.create");
    if(action?.type!=="card.create"||action.card.type!=="ExtensionCard")throw Error("TEST expected extension");
    expect(action.card.displayProps).toMatchObject({...full,def:{id:def.manifest.id,version:def.manifest.version,hash:def.hash}});
    expect(action.card.id).not.toBe(def.manifest.id);expect(action.card.metadata.createdAt).toBe(time.toISOString());
    expect(r.envelope!.actions).toContainEqual({type:"card.focus",targetId:action.card.id});
    const prompt=f.generate.mock.calls[0] as unknown as [Array<{content:string}>];
    expect(prompt[0][0]!.content).not.toContain("2026-01-15");expect(prompt[0][0]!.content).not.toContain("DEMO：日期、部位和分钟数均为虚构示例");
  });
  it.each(["id","layout","metadata"])("rejects %s injected into extension fact data",async key=>{
    vi.useFakeTimers();vi.setSystemTime(time);const def=await fixture(),f=setup(def,[{slots:{...data,[key]:"TEST-injected"}}]);
    const r=await runSlotPlanner({text:"今天练了40分钟背",canvasContext:ctx},f.deps);
    expect(r.envelope).toBeUndefined();expect(r.kind).toBe("clarify");
  });
  it.each([{...data,minutes:25},{...data,trainingDate:"2026-01-15"}])("rejects DEMO facts not present in this request: %j",async value=>{
    vi.useFakeTimers();vi.setSystemTime(time);const def=await fixture(),f=setup(def,[{slots:value}]);
    const r=await runSlotPlanner({text:"今天练了40分钟背",canvasContext:ctx},f.deps);
    expect(r.kind).toBe("clarify");expect(r.envelope).toBeUndefined();
  });
  it.each([40,25])("allows only fixed configuration defaults, never the same number as an invented fact: %s",async minutes=>{
    vi.useFakeTimers();vi.setSystemTime(time);const original=await fixture();
    const files=Object.fromEntries(Object.entries(original.files).map(([key,value])=>[key,JSON.stringify(value)]));
    const config=JSON.parse(files['config.schema.json']!);config.properties.goal={type:'integer',default:25};config.default.goal=25;files['config.schema.json']=JSON.stringify(config);
    const def=await parsePackageFiles(files),f=setup(def,[{slots:{data:{...data,minutes}}}]);
    const r=await runSlotPlanner({text:"今天练了40分钟背",canvasContext:ctx},f.deps);
    if(minutes===25){expect(r.kind).toBe('clarify');expect(r.envelope).toBeUndefined();}
    else{expect(r.kind).toBe('envelope');const a=r.envelope!.actions.find(a=>a.type==='card.create');if(a?.type!=='card.create')throw Error('TEST expected creation');expect(a.card.displayProps).toMatchObject({config:{goal:25},data:{minutes:40}});}
  });
  it("reports a known parameter path for repair without forwarding upstream values",async()=>{
    vi.useFakeTimers();vi.setSystemTime(time);const def=await fixture(),f=setup(def,[{slots:{...full,data:{...data,minutes:"TEST-private-value"}}},{slots:full}]);
    const r=await runSlotPlanner({text:"今天练了40分钟背",canvasContext:ctx},f.deps);
    expect(r.kind).toBe("envelope");expect(f.generate).toHaveBeenCalledTimes(2);
    const messages=f.generate.mock.calls[1] as unknown as [Array<{content:string}>];
    expect(messages[0][1]!.content).toContain("slots.data.minutes");expect(messages[0][1]!.content).not.toContain("TEST-private-value");
  });
  it("preserves manifest.slots restrictions on the older scene-payload path too",async()=>{
    vi.useFakeTimers();vi.setSystemTime(time);const def=await fixture();
    const files=Object.fromEntries(Object.entries(def.files).map(([key,value])=>[key,JSON.stringify(value)]));
    const manifest=JSON.parse(files['manifest.json']!);manifest.slots.properties.minutes.maximum=30;files['manifest.json']=JSON.stringify(manifest);
    const restricted=await parsePackageFiles(files);
    const r=await buildAllSceneActions([{scene_id:`ext.${restricted.manifest.id}`,data:full}],{text:"今天练了40分钟背",ctx},[restricted]);
    expect(r.ok).toBe(false);
  });
  it("never adds an uninstalled route to the candidate catalog",async()=>{
    vi.useFakeTimers();vi.setSystemTime(time);const def=await fixture(),f=setup(def,[{slots:full}]);f.deps.definitions=[];
    const r=await runSlotPlanner({text:"今天练了40分钟背",canvasContext:ctx},f.deps);
    expect(r.kind).toBe("clarify");expect(f.generate).not.toHaveBeenCalled();
  });
  it.each([" HTTPS://unknown.test/private", "\nhttps://unknown.test/private\t", "h\tttps://unknown.test/private"])("does not let browser URL normalization bypass source checks: %s",async note=>{
    vi.useFakeTimers();vi.setSystemTime(time);const def=await fixture(),f=setup(def,[{slots:{...full,state:{note}}}]);
    const r=await runSlotPlanner({text:"今天练了40分钟背",canvasContext:ctx},f.deps);
    expect(r.kind).toBe("clarify");expect(r.envelope).toBeUndefined();
  });
});
