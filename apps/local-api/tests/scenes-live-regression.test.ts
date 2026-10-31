import { afterEach, describe, expect, it, vi } from "vitest";
import { SCENE_CARD_TYPE, type SceneId } from "@vivic/contracts";
import { buildSceneActions, buildScenePrompt } from "../src/scenes/index.js";
import { parseScenePayload } from "../src/scenes/payload.js";
import { runIntent } from "../src/intent/pipeline.js";
import { CredentialStore } from "../src/credentials.js";
import { buildProviderSceneActions, travelQueryIssue } from "../src/scenes/travel.js";
import { demoTravelProvider } from "../src/providers/travel.js";
import { chatOk, emptyContext, fetchStub } from "./helpers.js";
import { SCENE_CASES } from "./sceneCases.js";

const now=Date.parse("2026-10-23T14:25:00.000Z");
const sample=(scene:SceneId)=>SCENE_CASES.find(item=>item.scene===scene)!;
const request=(scene:SceneId)=>({text:sample(scene).input,ctx:{...emptyContext(),timeZone:"Asia/Shanghai"},now});
const build=(scene:SceneId,data:unknown)=>buildSceneActions([{scene_id:scene,data}],request(scene));
afterEach(()=>vi.useRealTimers());

describe("repairs from authored live scene fixtures without accepting malformed facts",()=>{
  it("reports the fixed scene category and author shape together, but never coerces them",()=>{
    // Observed synthetic StepFun response: an instance ID and an array author.
    const raw={scene_id:"book_record_20261023",card_type:"BookCard",data:{...sample("book_record").payload,author:["丹尼尔·卡尼曼"]}};
    const result=parseScenePayload(raw);
    expect(result.ok).toBe(false);
    if(result.ok) throw new Error("invalid response accepted");
    expect(result.issue).toContain("scene_id=book_record");expect(result.issue).toContain("author");expect(result.issue).toContain("单个字符串");
    expect(raw.data.author).toEqual(["丹尼尔·卡尼曼"]);
    expect(parseScenePayload({...raw,scene_id:"book_record"}).ok).toBe(false);
    expect(build("book_record",sample("book_record").payload).ok).toBe(true);
  });
  it.each([
    {scene:"photo_gallery" as const,raw:{scene_id:"gallery_20261023_1425",card_type:"photo_gallery",data:{title:"",images:[{url:"https://example.com/p1.jpg"}]}}},
    {scene:"activity_feed" as const,raw:{card_type:"activity_feed",data:{title:"最近活动",live:true}}},
  ])("only explains the canonical $scene identity; correction still must pass parsing",({scene,raw})=>{
    const result=parseScenePayload(raw);expect(result.ok).toBe(false);
    if(result.ok) throw new Error("invalid response accepted");
    expect(result.issue).toContain(`scene_id=${scene}`);expect(result.issue).toContain(SCENE_CARD_TYPE[scene]);
    expect(build(scene,sample(scene).payload).ok).toBe(true);
  });
  it("rejects an invented publication date and tells the planner to omit the optional field, not ask for the known event date",()=>{
    const result=build("news_summary",{...sample("news_summary").payload,publishedAt:"2026-10-23"});
    expect(result.ok).toBe(false);
    if(result.ok) throw new Error("invented date accepted");
    expect(result.issue).toContain("省略");expect(result.issue).toContain("publishedAt");expect(result.ask).toBeUndefined();
    const corrected=build("news_summary",sample("news_summary").payload);expect(corrected.ok).toBe(true);
    if(corrected.ok) expect(corrected.cards[0]!.displayProps).not.toHaveProperty("publishedAt");
  });
  it("rejects the copied weekly goal of four while retaining the three evidence-based dates",()=>{
    const data={habit:"跑步",checkins:["2026-10-15","2026-10-16","2026-10-23"]};
    const result=build("habit_tracking",{...data,weeklyGoal:4});expect(result.ok).toBe(false);
    if(result.ok) throw new Error("invented goal accepted");
    expect(result.issue).toContain("weeklyGoal");expect(result.ask).toBeUndefined();
    const corrected=build("habit_tracking",data);expect(corrected.ok).toBe(true);
    if(corrected.ok) expect(corrected.cards[0]!.displayProps).toEqual(data);
  });
  it("keeps exact option-name grounding instead of silently relabeling the user's options",()=>{
    expect(build("option_comparison",{...sample("option_comparison").payload,options:["方案A","方案B","方案C"]}).ok).toBe(false);
    expect(build("option_comparison",sample("option_comparison").payload).ok).toBe(true);
  });
  it("does not expose placeholder question-mark keys or an ungrounded default goal in the model's actual prompt",()=>{
    const prompt=buildScenePrompt();
    expect(prompt).not.toMatch(/"[^"\n]+\?"\s*:/);
    expect(prompt).not.toContain('"weeklyGoal":4');
    expect(prompt).toContain("不是实例id");expect(prompt).toContain("author是单个字符串");
  });
  it("uses one existing repair round for both identifier and author errors in the real pipeline",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(now);
    const credentials=new CredentialStore();credentials.set({apiKey:"synthetic-scene-test-only",models:["step-3.5-flash"],defaultModel:"step-3.5-flash",checkedAt:"TEST"});
    const users:string[]=[];
    const invalid={cards:[{scene_id:"book_record_20261023",card_type:"BookCard",data:{...sample("book_record").payload,author:["丹尼尔·卡尼曼"]}}]};
    const correct={cards:[{scene_id:"book_record",data:sample("book_record").payload}]};
    const call=vi.fn((init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body));users.push(body.messages[1].content);
      return chatOk(users.length===1?invalid:correct);
    });
    const result=await runIntent({text:sample("book_record").input,canvasContext:request("book_record").ctx},{credentials,stepfun:{baseUrl:"https://unit.test/v1",fetchImpl:fetchStub({"/chat/completions":call})}});
    expect(call).toHaveBeenCalledTimes(2);expect(users[1]).toContain("scene_id=book_record");expect(users[1]).toContain("author");
    expect(result.envelope?.actions.filter(action=>action.type==="card.create").map(action=>action.card.type)).toEqual(["BookCard"]);
  });
  it("repairs invented travel startDate without losing an evidenced coarse date or bypassing missing parameters",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(now);
    const correct={kind:"hotel" as const,destination:"杭州",dateText:"下周",nights:2,budget:500};
    const invalid={...correct,startDate:"2026-10-27"};
    const provider={query:vi.fn(demoTravelProvider.query)};
    const rejected=await buildProviderSceneActions([{scene_id:"travel_offers",data:invalid}],request("travel_offers"),provider);
    expect(rejected.ok).toBe(false);expect(provider.query).not.toHaveBeenCalled();
    if(rejected.ok) throw new Error("invented travel date accepted");
    expect(rejected.ask).toBeUndefined();expect(rejected.issue).toContain("省略");
    expect(travelQueryIssue({kind:"hotel",destination:"杭州",dateText:"下周"},request("travel_offers"))?.ask).toBe("计划住几晚？");
    expect(travelQueryIssue({kind:"hotel",destination:"杭州",nights:2},request("travel_offers"))?.ask).toBe("计划哪天出发或入住？");
    const credentials=new CredentialStore();credentials.set({apiKey:"synthetic-travel-test-only",models:["step-3.5-flash"],defaultModel:"step-3.5-flash",checkedAt:"TEST"});
    const users:string[]=[];
    const call=vi.fn((init?:RequestInit)=>{const body=JSON.parse(String(init?.body));users.push(body.messages[1].content);return chatOk({cards:[{scene_id:"travel_offers",data:users.length===1?invalid:correct}]});});
    const result=await runIntent({text:sample("travel_offers").input,canvasContext:request("travel_offers").ctx},{credentials,travel:provider,stepfun:{baseUrl:"https://unit.test/v1",fetchImpl:fetchStub({"/chat/completions":call})}});
    expect(call).toHaveBeenCalledTimes(2);expect(users[1]).toContain("travel_offers.startDate");expect(provider.query).toHaveBeenCalledOnce();
    const created=result.envelope?.actions.find(action=>action.type==="card.create");
    expect(created?.type==="card.create" && created.card).toMatchObject({type:"TravelOffersCard",displayProps:{mode:"demo",query:correct},sourceData:{provider:"vivic-demo"}});
    if(created?.type==="card.create" && created.card.type==="TravelOffersCard") expect(created.card.displayProps.query).not.toHaveProperty("startDate");
  });
});
