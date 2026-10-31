/** Frozen G replay against the current ON backend. No key handling or deployment. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';
import { makeFixtureCards, contextFor } from './replay-eval.mjs';
import { confirmedOwnerWrite } from './eval-owner-write.mjs';

const argv=process.argv.slice(2), option=name=>argv[argv.indexOf(name)+1];
for(const name of ['--credentials','--dataset','--output'])assert(argv.includes(name),'Missing '+name);
const credential=JSON.parse(readFileSync(option('--credentials'),'utf8'));
assert(credential.evaluation&&credential.username.startsWith('decision-eval-')&&credential.accountId&&credential.spaceId,'Reserved evaluation account required');
const data=JSON.parse(readFileSync(option('--dataset'),'utf8'));
const apiRoot=resolve(process.env.VIVIC_REPLAY_API_ROOT||'/app/apps/local-api/src');
const require=createRequire(resolve(apiRoot,'../package.json'));
const {CardRecordSchema,resumeReminderSource}=await import(pathToFileURL(require.resolve('@vivic/contracts')));
const {executeHostedEnvelope}=await import(pathToFileURL(resolve(apiRoot,'space/executor.ts')));
const {redactDecisionText}=await import(pathToFileURL(resolve(apiRoot,'decision/logging.ts')));
const owner=`/api/space/owner/canvases/${credential.spaceId}`,run=randomUUID().replaceAll('-','').slice(0,12);
const report={at:new Date().toISOString(),mode:'on',scope:'Frozen synthetic API replay with the real connected main model; persistence and execution receipts. Transient browser visuals are verified separately.',datasetVersion:data.version,rows:[],complete:false,cleanup:false};
const selected=argv.includes('--cases')?option('--cases').split(',').map(id=>{const row=data.cases.find(test=>test.id===id);assert(row,'Unknown case');return row;}):data.cases;
let entry,original,activeTask;
let lastResidentReadyAt=0;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const saveReport=()=>writeFileSync(option('--output'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function waitForResident(){
  if(!argv.includes('--wait-resident')||Date.now()-lastResidentReadyAt<10000)return;
  const repo=resolve(import.meta.dirname,'..'),python=process.env.VIVIC_SSH_PYTHON||(process.platform==='win32'?resolve(process.env.LOCALAPPDATA,'Programs/Python/Python312/python.exe'):'python3');
  const runner=process.env.VIVIC_MAC_SSH_RUNNER||resolve(repo,'../tools/macssh.py');
  const code='import json,urllib.request\nwith urllib.request.urlopen("http://127.0.0.1:19095/health",timeout=10) as response: print(json.dumps(json.load(response)))\n';
  const started=Date.now();
  for(let attempt=0;attempt<80;attempt++){
    const health=await new Promise((yes,no)=>{const child=spawn(python,['-I',runner],{stdio:['pipe','pipe','pipe']});let output='';const timer=setTimeout(()=>{child.kill();no(Error('Resident preflight timed out'));},30000);child.stdout.on('data',chunk=>output+=chunk);child.stderr.resume();child.on('error',error=>{clearTimeout(timer);no(error);});child.on('exit',status=>{clearTimeout(timer);if(status!==0)no(Error('Resident preflight unavailable'));else try{yes(JSON.parse(output));}catch{no(Error('Resident preflight invalid response'));}});child.stdin.end(code);});
    if(health.loaded===true&&health.paused_for_large_model!==true){lastResidentReadyAt=Date.now();report.residentWaitMs=(report.residentWaitMs||0)+Date.now()-started;return;}
    if(attempt%4===0)console.log(JSON.stringify({waitingForResident:true,completed:report.rows.length,pausedForLargeModel:health.paused_for_large_model===true}));
    await sleep(15000);
  }
  throw Error('Resident model did not become available within the bounded preflight wait');
}
function transport(path,method='GET',body,stream=false){return new Promise((yes,no)=>{
  const url=new URL(path,credential.origin),serialized=body===undefined?undefined:JSON.stringify(body);
  const request=(url.protocol==='https:'?https:http).request(url,{method,agent:false,headers:{Cookie:credential.cookie,Origin:credential.origin,'Content-Type':'application/json',Accept:stream?'text/event-stream':'application/json',...(serialized?{'Content-Length':Buffer.byteLength(serialized)}:{})}},response=>{
    const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024)request.destroy(Error('Response exceeds replay limit'));else chunks.push(chunk);});response.on('end',()=>yes({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));response.on('error',no);
  });request.setTimeout(105000,()=>request.destroy(Error('Replay HTTP deadline')));request.on('error',no);request.end(serialized);
});}
async function api(path,method='GET',body){for(let attempt=0;attempt<4;attempt++){let response;try{response=await transport(path,method,body);}catch(error){if(method!=='GET'||attempt===3)throw error;await sleep(500*(attempt+1));continue;}if(response.status===429){await sleep(2500*(attempt+1));continue;}assert(response.status>=200&&response.status<300,`Replay HTTP ${response.status} ${path}`);return JSON.parse(response.body);}throw Error('Rate limit did not clear');}
async function save(record,suffix){
  const requestId=`g_${run}_${suffix}_${randomUUID().slice(0,6)}`,body={record:{...record,version:entry.record.version+1,updatedAt:new Date().toISOString()},expectedVersion:entry.serverVersion,requestId};
  const saved=await confirmedOwnerWrite(api,credential.spaceId,body);entry=saved.entry;
  if(saved.recoveredAfterWriteError)(report.writeRecoveries||=[]).push({requestId,phase:suffix,error:saved.recoveredAfterWriteError});
  return{requestId,storageReceipt:saved.storageReceipt,recoveredAfterWriteError:saved.recoveredAfterWriteError};
}
async function seed(id){const cards=makeFixtureCards(data.canvas,new Date().toISOString()).map(card=>CardRecordSchema.parse(card));await save({...original,cardsById:Object.fromEntries(cards.map(card=>[card.id,card])),cardOrder:cards.map(card=>card.id),focusHistory:[data.canvas.focused]},'seed_'+id);}
function parseSse(body){return body.replaceAll('\r\n','\n').split('\n\n').flatMap(frame=>{const lines=frame.split('\n'),event=lines.find(line=>line.startsWith('event:'))?.slice(6).trim(),text=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');try{return[{event,data:JSON.parse(text)}];}catch{return[];}});}
async function invoke(text,task){const start=performance.now(),response=await transport('/api/intent/stream','POST',{text,canvasContext:contextFor(entry.record,entry.serverVersion),task},true);assert.equal(response.status,200);const events=parseSse(response.body),result=events.findLast(event=>event.event==='result')?.data;assert(result,'Missing SSE result');return{result,totalMs:Math.round(performance.now()-start),plannerProgress:events.filter(event=>event.event==='progress'&&event.data.stage==='planner'&&event.data.status==='started').length};}
async function apply(result,test){
  const created=result.envelope?.actions.filter(action=>action.type==='card.create').map(action=>action.card.id)||[];
  if(test.route!=='delete'&&result.envelope?.actions.some(action=>['card.delete','cards.delete'].includes(action.type)))return{committed:false,reason:'unexpected-destructive-proposal-not-acknowledged',createdCardIds:[]};
  if(result.envelope){
    const record=structuredClone(entry.record),updated=executeHostedEnvelope({title:record.title,document:{cards:record.cardOrder.map(id=>record.cardsById[id])}},result.envelope,new Date().toISOString());
    record.cardsById=Object.fromEntries(updated.document.cards.map(card=>[card.id,card]));record.cardOrder=updated.document.cards.map(card=>card.id);
    const focus=result.envelope.actions.findLast(action=>action.type==='card.focus');if(focus)record.focusHistory=[...record.focusHistory,focus.targetId].slice(-20);
    record.processedRequestIds=[...record.processedRequestIds||[],result.envelope.requestId].slice(-500);const saved=await save(record,'apply_'+test.id);
    return{committed:true,createdCardIds:created,...saved};
  }
  const operation=result.hostOperation;if(!operation)return{committed:false,reason:'no-proposal',createdCardIds:[]};
  const record=structuredClone(entry.record),card=record.cardsById[operation.targetId];
  if(operation.kind==='card.pin'&&card)card.layout.pinned=operation.pinned;
  else if(operation.kind==='card.surface'&&card)card.layout.surface=operation.surface;
  else if(operation.kind==='countdown.pause'&&card?.type==='CountdownCard')card.sourceData.pausedAt=new Date().toISOString();
  else if(operation.kind==='countdown.resume'&&card?.type==='CountdownCard')card.sourceData=resumeReminderSource(card,Date.now());
  else if(['history.undo','history.redo'].includes(operation.kind))return{committed:false,reason:'browser-owner-history-requires-live-ui',scopeExcluded:true,createdCardIds:[]};
  else if(operation.kind==='canvas.arrange'){
    await api(`/api/space/spaces/${credential.spaceId}/commands`,'POST',{requestId:`g_${run}_operation_${test.id}`,expectedVersion:entry.serverVersion,command:{type:operation.kind}});entry=await api(owner);return{committed:true,createdCardIds:[]};
  }else return{committed:false,reason:'transient-ui-operation-outside-api-replay',createdCardIds:[]};
  await save(record,'host_'+test.id);return{committed:true,createdCardIds:[]};
}
try{
  const session=await api('/api/space/session');assert.equal(session.user.id,credential.accountId);assert.equal(session.user.username,credential.username);
  entry=await api(owner);original=structuredClone(entry.record);assert.equal(original.cardOrder.length,0,'Evaluation Space must start empty');assert.equal((await api('/api/space/cards')).definitions.length,0,'Frozen replay requires empty extension catalog');
  assert((await api('/api/providers/status')).providers.some(provider=>provider.connected),'Real main model must be connected');
  report.modelConnected=true;report.datasetCaseCount=data.cases.length;
  for(const test of selected){
    await waitForResident();await seed(test.id);const taskId=`g_${run}_${test.id}`;activeTask={id:taskId,text:test.text};
    const first=await invoke(test.text,{id:taskId});let result=first.result;
    const row={id:test.id,text:test.text,expected:test.route,expectedTarget:test.target||null,totalMs:first.totalMs,kind:result.kind,message:redactDecisionText(result.message||''),plannerProgress:first.plannerProgress,trace:result.trace||null,createdTypes:result.envelope?.actions.filter(action=>action.type==='card.create').map(action=>action.card.type)||[],clarification:result.task?.clarification?.kind||null};
    if(row.trace?.status==='pending')for(let attempt=0;attempt<20;attempt++){await sleep(500);const logs=await api('/api/space/decision-log?limit=30'),trace=logs.entries.find(log=>log.trace.id===row.trace.id)?.trace;if(trace&&trace.status!=='pending'){row.trace=trace;break;}}
    row.routeCorrect=row.trace?.route===test.route;
    const target=row.trace?.target;row.observedTarget=target?.targetId||(target?.ambiguous?'ambiguous':target?.missing?'missing':null);
    row.targetCorrect=test.target?row.observedTarget===test.target:null;
    // Confirm only a unique synthetic deletion that this frozen case actually requested.
    if(test.route==='delete'&&test.target!=='ambiguous'&&test.target!=='missing'&&result.kind==='clarify'&&result.message.includes('确定删除')){
      const before=await api(owner);row.deletionAskedWithoutMutation=JSON.stringify(before.record)===JSON.stringify(entry.record);
      const confirmation=await invoke('确定',{id:taskId});result=confirmation.result;row.confirmationMs=confirmation.totalMs;row.confirmedKind=result.kind;
    }
    let execution={committed:false,createdCardIds:[],reason:'no-action-proposal'};
    try{if(result.envelope||result.hostOperation)execution=await apply(result,test);}catch(error){execution={committed:false,createdCardIds:[],reason:'owner-commit-rejected: '+String(error.message).slice(0,120)};}
    row.execution=execution;
    if(execution.scopeExcluded){const cancelled=await api('/api/intent','POST',{text:test.text,canvasContext:contextFor(entry.record,entry.serverVersion),task:{id:taskId,cancel:true}});row.replayCancelledUiOnlyProposal=cancelled.task?.status;}
    else if(result.task?.executionId){const receipt=await api('/api/intent','POST',{text:test.text,canvasContext:contextFor(entry.record,entry.serverVersion),task:{id:taskId,receipt:{executionId:result.task.executionId,status:execution.committed?'succeeded':'failed',createdCardIds:execution.createdCardIds,...(!execution.committed?{error:execution.reason}: {})}}});row.receiptStatus=receipt.task?.status;}
    else if(result.task&&!['completed','cancelled','failed'].includes(result.task.status)){const cancelled=await api('/api/intent','POST',{text:test.text,canvasContext:contextFor(entry.record,entry.serverVersion),task:{id:taskId,cancel:true}});row.replayCancelledUnansweredClarification=cancelled.task?.status;}
    activeTask=null;report.rows.push(row);saveReport();
    if(report.rows.length%10===0||report.rows.length===selected.length)console.log(JSON.stringify({completed:report.rows.length,total:selected.length,routeCorrect:report.rows.filter(row=>row.routeCorrect).length,lastKind:row.kind}));
    // Keep real search calls below their ten-per-minute window without changing the input corpus.
    if(test.route==='search')await sleep(6500);
  }
  report.complete=report.rows.length===selected.length;
}catch(error){report.failure=redactDecisionText(String(error.message)).slice(0,240);process.exitCode=1;}
finally{
  try{
    if(activeTask)await api('/api/intent','POST',{text:activeTask.text,canvasContext:contextFor(entry.record,entry.serverVersion),task:{id:activeTask.id,cancel:true}});
    if(original){entry=await api(owner);await save(original,'restore');report.cleanup=(await api(owner)).record.cardOrder.length===0;}
  }catch(error){report.cleanupFailure=String(error.message).slice(0,160);process.exitCode=1;}
  const quantile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]:null;
  const traces=report.rows.map(row=>row.trace).filter(Boolean),latencies=report.rows.map(row=>row.totalMs);
  report.summary={cases:report.rows.length,routeCorrect:report.rows.filter(row=>row.routeCorrect).length,routeAccuracy:report.rows.length?report.rows.filter(row=>row.routeCorrect).length/report.rows.length:null,
    routeP50Ms:quantile(traces.map(trace=>trace.routeLatencyMs).filter(Number.isFinite),.5),routeP95Ms:quantile(traces.map(trace=>trace.routeLatencyMs).filter(Number.isFinite),.95),
    responseP50Ms:quantile(latencies,.5),responseP95Ms:quantile(latencies,.95),missingTraces:report.rows.filter(row=>!row.trace).length,pendingTraces:traces.filter(trace=>trace.status==='pending').length,
    serviceFailures:traces.reduce((sum,trace)=>sum+(trace.failedCount||0),0),directClauses:traces.reduce((sum,trace)=>sum+(trace.directClauses||0),0),plannerCalls:traces.reduce((sum,trace)=>sum+(trace.plannerCalls||0),0),
    persistedProposals:report.rows.filter(row=>row.execution.committed).length,rejectedCommits:report.rows.filter(row=>row.execution.reason?.startsWith('owner-commit-rejected')).length,
    kindCounts:Object.fromEntries([...new Set(report.rows.map(row=>row.kind))].map(kind=>[kind,report.rows.filter(row=>row.kind===kind).length]))};
  report.datasetCasesSha256=createHash('sha256').update(JSON.stringify(data.cases)).digest('hex');saveReport();console.log(JSON.stringify({...report,rows:undefined}));
}
