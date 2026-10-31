/** Operator-run live acceptance. No keys are accepted or stored by this script. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeFixtureCards, contextFor } from './replay-eval.mjs';

const argv=process.argv.slice(2), option=name=>argv[argv.indexOf(name)+1];
for(const flag of ['--credentials','--dataset','--output']) assert(argv.includes(flag),'Missing '+flag);
const c=JSON.parse(readFileSync(option('--credentials'),'utf8'));
assert(c.evaluation && /^decision-eval-/.test(c.username) && c.accountId && c.spaceId,'Evaluation identity required');
const dataset=JSON.parse(readFileSync(option('--dataset'),'utf8'));
const root=process.env.VIVIC_REPLAY_API_ROOT || '/app/apps/local-api/src';
const { CardRecordSchema }=await import('@vivic/contracts');
const { executeHostedEnvelope }=await import(pathToFileURL(resolve(root,'space/executor.ts')));
const { redactDecisionText }=await import(pathToFileURL(resolve(root,'decision/logging.ts')));
const token=randomUUID().replaceAll('-','').slice(0,12);
const owner='/api/space/owner/canvases/'+c.spaceId;
function transport(path,method,body,stream=false){
 return new Promise((yes,no)=>{
  const url=new URL(c.origin+path),serialized=body===undefined?undefined:JSON.stringify(body);
  const request=(url.protocol==='https:'?https:http).request(url,{method,headers:{cookie:c.cookie,origin:c.origin,
   'content-type':'application/json',accept:stream?'text/event-stream':'application/json',
   ...(serialized?{'content-length':Buffer.byteLength(serialized)}:{})}},response=>{
    let text='';response.setEncoding('utf8');response.on('data',data=>{text+=data;});
    response.on('end',()=>yes({status:response.statusCode,body:text}));response.on('error',no);
   });
  request.setTimeout(105000,()=>request.destroy(Error('Evaluation HTTP deadline')));
  request.on('error',no);request.end(serialized);
 });
}
async function api(path,method='GET',body){const r=await transport(path,method,body);assert(r.status>=200&&r.status<300,`Evaluation HTTP ${r.status} ${path}`);return JSON.parse(r.body);}
let entry,original;
const report={at:new Date().toISOString(),model:option('--model') || 'step-3.7-flash',mode:'shadow',
 observerDrainBetweenCases:true,
 scope:'Frozen creation/answer subset plus one real vision case. Synthetic inputs, actual hosted HTTP and upstream model.',
 originalCaseCount:0,rows:[],complete:false,cleanup:false};
const saveReport=()=>writeFileSync(option('--output'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function save(record,suffix){entry=await api(owner,'PUT',{record:{...record,version:entry.record.version+1,updatedAt:new Date().toISOString()},expectedVersion:entry.serverVersion,requestId:`d_eval_${token}_${suffix}`});}
function channelsValid(envelope){if(!envelope)return null;const speech=envelope.spokenText||'';return speech.length<=40&&!/http|\d{6,}/i.test(speech)
 &&envelope.actions.filter(a=>a.type==='subtitle.show').length<=1&&envelope.actions.filter(a=>a.type==='subtitle.show').every(a=>a.text.length<=120);}
async function one(test){
 const fixtures=makeFixtureCards(dataset.canvas,new Date().toISOString()).map(card=>CardRecordSchema.parse(card));
 await save({...entry.record,cardsById:Object.fromEntries(fixtures.map(card=>[card.id,card])),cardOrder:fixtures.map(card=>card.id),focusHistory:[dataset.canvas.focused]},'seed_'+test.id);
 const taskId=`d_eval_${token}_${test.id}`,start=performance.now();
 const response=await transport('/api/intent/stream','POST',{text:test.text,canvasContext:contextFor(entry.record,entry.serverVersion),task:{id:taskId},...(test.attachments?{attachments:test.attachments}:{})},true);
 assert(response.status===200,`Intent HTTP ${response.status}`);
 const events=response.body.replaceAll('\r\n','\n').split('\n\n').filter(Boolean).map(frame=>{
  const lines=frame.split('\n'),event=lines.find(line=>line.startsWith('event:'))?.slice(6).trim(),data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
  if(!data)return null;try{return {event,data:JSON.parse(data)};}catch{return null;}
 }).filter(Boolean);
 const result=events.findLast(event=>event.event==='result')?.data;assert(result,'SSE result missing');
 const totalMs=Math.round(performance.now()-start);
 const plannerCalls=events.filter(event=>event.event==='progress'&&event.data.stage==='planner'&&event.data.status==='started').length;
 const created=(result.envelope?.actions||[]).filter(action=>action.type==='card.create').map(action=>CardRecordSchema.parse(action.card));
 let committed=false,receiptStatus,retainedImage=false;
 if(result.envelope){
  const record=structuredClone(entry.record);
  const content=executeHostedEnvelope({title:record.title,document:{cards:record.cardOrder.map(id=>record.cardsById[id])}},result.envelope,new Date().toISOString());
  record.cardsById=Object.fromEntries(content.document.cards.map(card=>[card.id,card]));record.cardOrder=content.document.cards.map(card=>card.id);
  const focus=result.envelope.actions.findLast(action=>action.type==='card.focus');if(focus)record.focusHistory=[...record.focusHistory,focus.targetId].slice(-20);
  await save(record,'apply_'+test.id);committed=true;
  if(test.attachments){
   const image=created.find(card=>card.type==='NewsCard')?.displayProps.image;
   if(/^media:image_[a-f0-9]{64}$/.test(image||'')){
    const r=await transport(`/api/space/spaces/${c.spaceId}/assets/${image.slice(6)}`,'GET');
    retainedImage=r.status===200&&JSON.parse(r.body).asset?.kind==='image';
   }
  }
  if(result.task?.executionId){const receipt=await api('/api/intent','POST',{text:test.text,canvasContext:contextFor(entry.record,entry.serverVersion),task:{id:taskId,receipt:{executionId:result.task.executionId,status:'succeeded',createdCardIds:created.map(card=>card.id)}}});receiptStatus=receipt.task?.status;}
 }
 const row={id:test.id,route:test.route,text:test.text,totalMs,plannerCalls,usedProvider:result.usedProvider||null,kind:result.kind,
  message:redactDecisionText(result.message||''),cardTypes:created.map(card=>card.type),committed,receiptStatus:receiptStatus||null,
  channelsValid:channelsValid(result.envelope),retainedImage:test.attachments?retainedImage:undefined,
  cards:created.map(card=>({type:card.type,displayProps:card.displayProps,sourceData:card.sourceData})),
  trace:result.trace?{route:result.trace.route,probability:result.trace.probability,status:result.trace.status,failedCount:result.trace.failedCount}:null};
 // Fast rules return before detached classification ends. Drain observation
 // outside measured response time, avoiding an unintended queue-load benchmark.
 if(result.trace?.status==='pending'){
  const start=performance.now();
  for(let i=0;i<10;i++){
   await new Promise(resolve=>setTimeout(resolve,500));
   const logs=await api('/api/space/decision-log?limit=20');
   const trace=logs.entries.find(entry=>entry.trace.id===result.trace.id)?.trace;
   if(trace&&trace.status!=='pending'){row.trace={route:trace.route,probability:trace.probability,status:trace.status,failedCount:trace.failedCount};break;}
  }
  row.observerDrainMs=Math.round(performance.now()-start);
 }
 if(test.attachments){const words=JSON.stringify(row.cards);row.imageColorsCorrect=/蓝/.test(words)&&/橙|橘|桔/.test(words);}
 report.rows.push(row);saveReport();
 console.log(JSON.stringify({id:row.id,kind:row.kind,cardTypes:row.cardTypes,plannerCalls:row.plannerCalls,totalMs:row.totalMs}));
}
let initialAssets=[];
try{
 const session=await api('/api/space/session');assert(session.user?.id===c.accountId&&session.user?.username===c.username,'Identity mismatch');
 entry=await api(owner);original=structuredClone(entry.record);assert(original.cardOrder.length===0,'Evaluation Space must be empty before replay');
 initialAssets=(await api(`/api/space/spaces/${c.spaceId}/assets`)).assets.map(asset=>asset.id);
 const connected=await api('/api/providers/status');assert(connected.providers?.some(p=>p.connected),'Connect a model through the normal API first');
 const selected=await api('/api/providers/model','POST',{provider:'stepfun',model:report.model});assert(selected.ok,'Model selection failed');
 report.modelCapabilities=selected.capabilities;
 const allowed=new Set(['answer','countdown','todo','note','generate']);
 let cases=dataset.cases.filter(test=>allowed.has(test.route));report.originalCaseCount=cases.length;
 if(argv.includes('--smoke'))cases=['answer-01','note-03','generate-01'].map(id=>cases.find(test=>test.id===id)).filter(Boolean);
 if(argv.includes('--case')){cases=dataset.cases.filter(test=>test.id===option('--case'));assert(cases.length===1,'Missing case');}
 if(argv.includes('--cases'))cases=option('--cases').split(',').map(id=>{const test=dataset.cases.find(test=>test.id===id);assert(test,'Missing case '+id);return test;});
 report.selectedCaseIds=cases.map(test=>test.id);
 for(const test of cases)await one(test);
 if(!argv.includes('--no-image')){
  const sharp=(await import('sharp')).default;
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="white"/><rect x="50" y="55" width="240" height="250" rx="12" fill="#1767d3"/><rect x="350" y="55" width="240" height="250" rx="12" fill="#f49b22"/></svg>';
  const png=await sharp(Buffer.from(svg)).png().toBuffer();
  await one({id:'vision-01',route:'image_analysis',text:'分析这张图片里左右两块色块的颜色，并保留图片。',attachments:[{type:'image',mime:'image/png',data:png.toString('base64')}]});
 }
 report.complete=true;
}catch(error){report.failure=String(error.message).replace(/(sk-|nvapi-)[A-Za-z0-9_-]+/g,'[redacted]').slice(0,200);process.exitCode=1;}
finally{
 if(original&&entry){
  try{
   entry=await api(owner);await save(original,'restore');
   const assets=(await api(`/api/space/spaces/${c.spaceId}/assets`)).assets;
   for(const asset of assets)if(!initialAssets.includes(asset.id)){const r=await transport(`/api/space/spaces/${c.spaceId}/assets/${asset.id}`,'DELETE');assert(r.status>=200&&r.status<300,'Image cleanup failed');}
   report.cleanup=(await api(owner)).record.cardOrder.length===original.cardOrder.length;
  }catch{report.cleanup=false;report.cleanupFailure=true;process.exitCode=1;}
 }
 const p=values=>{const v=[...values].sort((a,b)=>a-b);return {p50:v[Math.ceil(v.length*.5)-1]??null,p95:v[Math.ceil(v.length*.95)-1]??null};};
 const llm=report.rows.filter(row=>row.plannerCalls>0);
 report.summary={requests:report.rows.length,modelRequests:llm.length,plannerCalls:llm.reduce((s,row)=>s+row.plannerCalls,0),
  repairedRequests:llm.filter(row=>row.plannerCalls>1).length,finalUnreliableParameters:llm.filter(row=>/没能形成可靠参数|输出未通过校验/.test(row.message)).length,
  kindCounts:Object.fromEntries([...new Set(report.rows.map(row=>row.kind))].map(kind=>[kind,report.rows.filter(row=>row.kind===kind).length])),
  allLatencyMs:p(report.rows.map(row=>row.totalMs)),modelLatencyMs:p(llm.map(row=>row.totalMs))};
 saveReport();console.log(JSON.stringify({...report,rows:undefined}));
}
