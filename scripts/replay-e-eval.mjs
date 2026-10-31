/** Live E acceptance: a reserved test account, normal APIs, no main-model key. */
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {makeFixtureCards,contextFor} from './replay-eval.mjs';
const args=process.argv.slice(2),arg=key=>args[args.indexOf(key)+1];
for(const key of ['--credentials','--dataset','--output'])assert(args.includes(key),'Missing '+key);
const c=JSON.parse(readFileSync(arg('--credentials'),'utf8')),dataset=JSON.parse(readFileSync(arg('--dataset'),'utf8'));
assert(c.evaluation&&c.username.startsWith('decision-eval-')&&c.accountId&&c.spaceId,'Reserved evaluation account required');
const {executeHostedEnvelope}=await import(pathToFileURL(resolve(process.env.VIVIC_REPLAY_API_ROOT||'/app/apps/local-api/src','space/executor.ts')));
const {CardRecordSchema}=await import('@vivic/contracts');
const run=randomUUID().replaceAll('-','').slice(0,10),owner='/api/space/owner/canvases/'+c.spaceId;
const report={at:new Date().toISOString(),mode:'on',direct:[],complete:false,cleanup:false};
let entry,original,activeHostedTask;
function transport(path,method='GET',body,sse=false){return new Promise((yes,no)=>{
 const url=new URL(c.origin+path),data=body===undefined?undefined:JSON.stringify(body);
 const req=(url.protocol==='https:'?https:http).request(url,{method,headers:{cookie:c.cookie,origin:c.origin,'content-type':'application/json',accept:sse?'text/event-stream':'application/json',...(data?{'content-length':Buffer.byteLength(data)}:{})}},res=>{
  let text='';res.setEncoding('utf8');res.on('data',v=>text+=v);res.on('end',()=>yes({status:res.statusCode,body:text}));res.on('error',no);
 });req.setTimeout(100000,()=>req.destroy(Error('Evaluation HTTP timeout')));req.on('error',no);req.end(data);
});}
async function api(path,method='GET',body){const r=await transport(path,method,body);assert(r.status>=200&&r.status<300,`Evaluation HTTP ${r.status}`);return JSON.parse(r.body);}
const saveReport=()=>writeFileSync(arg('--output'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function save(record,suffix){entry=await api(owner,'PUT',{record:{...record,version:entry.record.version+1,updatedAt:new Date().toISOString()},expectedVersion:entry.serverVersion,requestId:`e_${run}_${suffix}_${randomUUID().slice(0,8)}`});}
async function seed(){
 const cards=makeFixtureCards(dataset.canvas,new Date().toISOString()).map(card=>CardRecordSchema.parse(card));cards.find(card=>card.id==='note_meeting').layout.pinned=true;
 await save({...entry.record,cardsById:Object.fromEntries(cards.map(card=>[card.id,card])),cardOrder:cards.map(card=>card.id),focusHistory:[dataset.canvas.focused]},'seed');
}
function sse(body){return body.replaceAll('\r\n','\n').split('\n\n').filter(Boolean).map(frame=>{
 const lines=frame.split('\n'),event=lines.find(line=>line.startsWith('event:'))?.slice(6).trim(),value=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
 try{return{event,data:JSON.parse(value)};}catch{return null;}
}).filter(Boolean);}
async function invoke(text,task){
 const start=performance.now();const r=await transport('/api/intent/stream','POST',{text,canvasContext:contextFor(entry.record,entry.serverVersion),...(task?{task}: {})},true);
 assert.equal(r.status,200);const events=sse(r.body),result=events.findLast(x=>x.event==='result')?.data;assert(result,'Missing intent result');
 const elapsedMs=Math.round(performance.now()-start),calls=events.filter(x=>x.event==='progress'&&x.data.stage==='planner'&&x.data.status==='started').length;
 assert.equal(result.trace?.mode,'on');assert.equal(result.trace.plannerCalls,0);assert.equal(calls,0);
 if(result.trace.status==='pending')for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,500));const logs=await api('/api/space/decision-log?limit=20');if(logs.entries.find(x=>x.trace.id===result.trace.id)?.trace.status!=='pending')break;}
 return {result,elapsedMs};
}
async function apply(result,text){
 assert.equal(result.task?.status,'awaiting_execution');assert(result.envelope);
 const record=structuredClone(entry.record),updated=executeHostedEnvelope({title:record.title,document:{cards:record.cardOrder.map(id=>record.cardsById[id])}},result.envelope,new Date().toISOString());
 record.cardsById=Object.fromEntries(updated.document.cards.map(card=>[card.id,card]));record.cardOrder=updated.document.cards.map(card=>card.id);
 const focus=result.envelope.actions.findLast(a=>a.type==='card.focus');if(focus)record.focusHistory=[...record.focusHistory,focus.targetId].slice(-20);
 await save(record,'apply');const ids=result.envelope.actions.flatMap(a=>a.type==='card.create'?[a.card.id]:[]);
 const receipt=await api('/api/intent','POST',{text,canvasContext:contextFor(entry.record,entry.serverVersion),task:{id:result.task.id,receipt:{executionId:result.task.executionId,status:'succeeded',createdCardIds:ids}}});
 assert.equal(receipt.task?.status,'completed');return ids;
}
function fixtureNote(id,text){const stamp=new Date().toISOString();return CardRecordSchema.parse({id,type:'NoteCard',variant:'minimal',displayProps:{text},sourceData:{},sources:[],layout:{x:1600,y:500,width:320,height:120,pinned:false},metadata:{createdAt:stamp,updatedAt:stamp,aliases:[text]}});}
try{
 const session=await api('/api/space/session');assert.equal(session.user.id,c.accountId);assert.equal(session.user.username,c.username);
 entry=await api(owner);original=structuredClone(entry.record);assert.equal(original.cardOrder.length,0,'Test Space must be empty');
 const providers=await api('/api/providers/status');assert(!providers.providers.some(p=>p.connected),'Run this acceptance before connecting a main model');
 report.mainModelConnected=false;
 for(const [id,text,expected]of [['countdown','倒计时50分钟','CountdownCard'],['todo','添加待办：喝水、交周报','TodoCard'],['note','帮我记个便签明天交周报','NoteCard'],['overview','显示全部',null],['restore','恢复原视图',null],['multi','帮我记个便签明天交周报，再设个50分钟倒计时','multi']]){
  await seed();const pinned=structuredClone(entry.record.cardsById.note_meeting),{result,elapsedMs}=await invoke(text);
  assert.equal(result.kind,'envelope');const created=result.envelope.actions.flatMap(a=>a.type==='card.create'?[a.card]:[]);
  if(expected==='multi'){assert.deepEqual(created.map(c=>c.type),['NoteCard','CountdownCard']);assert.equal(result.envelope.actions.filter(a=>a.type==='canvas.fit').length,1);assert.equal(result.trace.directClauses,2);}
  else {if(expected)assert.deepEqual(created.map(c=>c.type),[expected]);assert.equal(result.trace.directClauses,1);}
  if(id==='countdown'){report.timerElapsedMs=elapsedMs;report.timerWithin3s=elapsedMs<3000;const source=created[0].sourceData;assert.equal(Date.parse(source.targetAt)-Date.parse(source.startedAt),3000000);}
  await apply(result,text);assert.deepEqual(entry.record.cardsById.note_meeting,pinned);
  report.direct.push({id,text,elapsedMs,plannerCalls:0,directClauses:result.trace.directClauses,cardTypes:created.map(c=>c.type),committed:true});saveReport();console.log(JSON.stringify(report.direct.at(-1)));
 }
 await seed();const before=JSON.stringify(entry.record);const q=(await invoke('删除读书笔记')).result;
 assert.equal(q.kind,'clarify');assert(q.message.includes('确定删除'));assert(!q.envelope);assert.equal(JSON.stringify((await api(owner)).record),before);
 const no=(await invoke('算了',{id:q.task.id})).result;assert.equal(no.task.status,'cancelled');
 const q2=(await invoke('删除读书笔记')).result;assert.equal(q2.kind,'clarify');
 const yes=(await invoke('确定',{id:q2.task.id})).result;assert(yes.envelope.actions.some(a=>a.type==='card.delete'&&a.targetId==='note_book'));
 await apply(yes,'确定');assert(!entry.record.cardsById.note_book);report.deletion={askedBeforeMutation:true,cancelKeptData:true,confirmedDeletedOnly:'note_book'};saveReport();
 await seed();const ambiguous=(await invoke('删除便签')).result;assert.equal(ambiguous.kind,'clarify');const candidates=ambiguous.task.clarification.candidates;assert(candidates.length===2);
 const selected=(await invoke('第一个',{id:ambiguous.task.id})).result;assert.equal(selected.kind,'clarify');assert(selected.message.includes('确定删除'));
 const confirmed=(await invoke('确定',{id:ambiguous.task.id})).result;assert(confirmed.envelope.actions.some(a=>a.type==='card.delete'&&a.targetId===candidates[0].id));await apply(confirmed,'确定');
 report.ambiguity={frozenCandidates:candidates.map(x=>({number:x.number,id:x.id,label:x.label})),chosenId:candidates[0].id,confirmationRequiredAfterSelection:true};saveReport();
 await seed();const stale=(await invoke('删除读书笔记')).result;const record=structuredClone(entry.record),newCard=fixtureNote(`e_change_${run}`,'确认期间新增');record.cardsById[newCard.id]=newCard;record.cardOrder.push(newCard.id);await save(record,'intervening');
 const staleYes=(await invoke('确定',{id:stale.task.id})).result;assert.equal(staleYes.task.status,'cancelled');assert(!staleYes.envelope);assert(entry.record.cardsById.note_book);report.changedTargetContextCancelled=true;
 await save({...entry.record,cardsById:{},cardOrder:[],focusHistory:[]},'before_conflict');
 const goal='帮我记个便签并发验证';const taskId=`e_conflict_${run}`,taskBase=`/api/space/spaces/${c.spaceId}/tasks`;
 const accepted=await api(taskBase,'POST',{requestId:taskId,text:goal,expectedVersion:entry.serverVersion});assert.equal(accepted.task.status,'accepted');activeHostedTask=taskBase+'/'+taskId;
 await new Promise(r=>setTimeout(r,100));const concurrent=fixtureNote(`e_concurrent_${run}`,'并发保留');const concurrentRecord=structuredClone(entry.record);concurrentRecord.cardsById[concurrent.id]=concurrent;concurrentRecord.cardOrder.push(concurrent.id);await save(concurrentRecord,'concurrent');
 let finished;for(let i=0;i<150;i++){finished=await api(activeHostedTask);if(['succeeded','failed','cancelled','unknown'].includes(finished.task.status))break;await new Promise(r=>setTimeout(r,400));}
 assert.equal(finished.task.status,'succeeded',finished.task.message);activeHostedTask=undefined;entry=await api(owner);
 const cards=Object.values(entry.record.cardsById);assert.equal(cards.filter(card=>card.displayProps.text==='并发验证').length,1);assert(cards.some(card=>card.id===concurrent.id));
 const logs=(await api('/api/space/decision-log?limit=30')).entries.filter(x=>x.text===goal);assert(logs.length>=2,'Expected a discarded proposal and a replan');assert(logs.some(x=>x.outcome==='conflict'||x.outcome==='failed'));assert(logs.some(x=>x.outcome==='succeeded'));assert(logs.every(x=>x.trace.plannerCalls===0));
 report.conflict={succeeded:true,createdOnce:true,concurrentWritePreserved:true,traceOutcomes:logs.map(x=>x.outcome)};report.functionalComplete=true;report.complete=report.timerWithin3s===true;
 if(!report.complete){report.failure=`50-minute timer exceeded 3 seconds: ${report.timerElapsedMs}ms`;process.exitCode=1;}
}catch(error){report.failure=String(error.message).slice(0,240);process.exitCode=1;}
finally{
 if(activeHostedTask)try{await api(activeHostedTask+'/cancel','POST');}catch{report.cancelFailure=true;}
 if(original)try{entry=await api(owner);await save(original,'restore');report.cleanup=(await api(owner)).record.cardOrder.length===0;}catch{report.cleanup=false;process.exitCode=1;}
 saveReport();console.log(JSON.stringify(report));
}
