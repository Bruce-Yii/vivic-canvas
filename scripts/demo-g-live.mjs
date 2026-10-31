/** Genuine image and extension samples for G's UI evidence. Reserved account only. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { contextFor } from './replay-eval.mjs';
import { confirmedOwnerWrite } from './eval-owner-write.mjs';
const argv=process.argv.slice(2),arg=key=>argv[argv.indexOf(key)+1];
for(const key of ['--credentials','--output','--image','--package'])assert(argv.includes(key),'Missing '+key);
const c=JSON.parse(readFileSync(arg('--credentials'),'utf8'));assert(c.evaluation&&c.username.startsWith('decision-eval-'));
const apiRoot=resolve(process.env.VIVIC_REPLAY_API_ROOT||'/app/apps/local-api/src');
const require=createRequire(resolve(apiRoot,'../package.json'));
const {executeHostedEnvelope}=await import(pathToFileURL(resolve(apiRoot,'space/executor.ts')));
const {CardRecordSchema}=await import(pathToFileURL(require.resolve('@vivic/contracts')));
const owner=`/api/space/owner/canvases/${c.spaceId}`,run=randomUUID().replaceAll('-','').slice(0,10);
const report={at:new Date().toISOString(),realModel:true,cases:[],visualSamples:[],complete:false,cleanup:{}};
let entry,original,installed,initialAssets=[];
async function api(path,method='GET',data){const response=await fetch(new URL(path,c.origin),{method,headers:{Cookie:c.cookie,Origin:c.origin,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(110000)});assert(response.ok,`Demo API ${response.status} ${path}`);return response.json();}
async function save(record,label){entry=await api(owner);const saved=await confirmedOwnerWrite(api,c.spaceId,{record:{...record,version:entry.record.version+1,updatedAt:new Date().toISOString()},expectedVersion:entry.serverVersion,requestId:`g_demo_${run}_${label}_${randomUUID().slice(0,6)}`});entry=saved.entry;return saved;}
async function invoke(id,text,attachments){
  const taskId=`g_demo_${run}_${id}`,started=performance.now(),result=await api('/api/intent','POST',{text,canvasContext:contextFor(entry.record,entry.serverVersion),task:{id:taskId},...(attachments?{attachments}:{})});
  const row={id,text,elapsedMs:Math.round(performance.now()-started),kind:result.kind,trace:result.trace||null,checks:{}};report.cases.push(row);
  assert(result.envelope,'Expected a real card proposal: '+id);
  const created=result.envelope.actions.filter(action=>action.type==='card.create').map(action=>CardRecordSchema.parse(action.card));
  const record=structuredClone(entry.record),updated=executeHostedEnvelope({title:record.title,document:{cards:record.cardOrder.map(id=>record.cardsById[id])}},result.envelope,new Date().toISOString());
  record.cardsById=Object.fromEntries(updated.document.cards.map(card=>[card.id,card]));record.cardOrder=updated.document.cards.map(card=>card.id);
  record.focusHistory=created.map(card=>card.id);await save(record,'apply_'+id);
  const receipt=await api('/api/intent','POST',{text,canvasContext:contextFor(entry.record,entry.serverVersion),task:{id:taskId,receipt:{executionId:result.task.executionId,status:'succeeded',createdCardIds:created.map(card=>card.id)}}});
  assert.equal(receipt.task.status,'completed');row.checks.durableCommitAndReceipt=true;row.created=created;
  report.visualSamples.push({id,record:structuredClone(entry.record)});
  return row;
}
try{
  const session=await api('/api/space/session');assert.equal(session.user.id,c.accountId);assert.equal(session.user.username,c.username);
  entry=await api(owner);original=structuredClone(entry.record);assert.equal(original.cardOrder.length,0);assert.equal((await api('/api/space/cards')).definitions.length,0);
  initialAssets=(await api(`/api/space/spaces/${c.spaceId}/assets`)).assets.map(asset=>asset.id);
  const image=await invoke('vision','分析这张图片里左右两块色块的颜色，并保留图片。',[{type:'image',mime:'image/png',data:readFileSync(arg('--image')).toString('base64')}]);
  const news=image.created.find(card=>card.type==='NewsCard');assert(news);image.checks.colors=JSON.stringify(news.displayProps).includes('蓝')&&/[橙橘桔]/.test(JSON.stringify(news.displayProps));
  image.checks.retainedImage=/^media:image_[a-f0-9]{64}$/.test(news.displayProps.image||'');assert(image.checks.retainedImage);
  const asset=await api(`/api/space/spaces/${c.spaceId}/assets/${news.displayProps.image.slice(6)}`);assert.equal(asset.asset.kind,'image');image.checks.assetStored=true;
  await save(original,'clear-image');
  const multi=await invoke('multi','帮我记个便签出门带钥匙，再设个10分钟倒计时');
  multi.checks.bothRequestsPresent=multi.created.some(card=>card.type==='NoteCard'&&card.displayProps.text.includes('钥匙'))&&multi.created.some(card=>card.type==='CountdownCard'&&Date.parse(card.sourceData.targetAt)-Date.parse(card.sourceData.startedAt)===600000);assert(multi.checks.bothRequestsPresent);
  await save(original,'clear-multi');
  const form=new FormData();form.set('file',new Blob([readFileSync(arg('--package'))],{type:'application/zip'}),'fitness-log-v02.vivicard');
  const uploaded=await fetch(new URL('/api/space/cards',c.origin),{method:'POST',headers:{Cookie:c.cookie,Origin:c.origin},body:form});assert(uploaded.ok);installed=(await uploaded.json()).record;
  const fitness=await invoke('extension','今天练了40分钟背');const card=fitness.created.find(card=>card.type==='ExtensionCard');assert(card);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  fitness.checks.realFacts=card.displayProps.data.trainingDate===today&&card.displayProps.data.bodyPart==='背'&&card.displayProps.data.minutes===40;assert(fitness.checks.realFacts);
  report.complete=true;
}catch(error){report.error=String(error.message).slice(0,240);process.exitCode=1;}
finally{
  try{
    if(original)await save(original,'restore');
    if(installed)await api(`/api/space/cards/${encodeURIComponent(installed.definition.manifest.id)}?hash=${installed.definition.hash}`,'DELETE');
    report.cleanup.emptySpace=(await api(owner)).record.cardOrder.length===0;report.cleanup.emptyCatalog=(await api('/api/space/cards')).definitions.length===0;
    const assets=(await api(`/api/space/spaces/${c.spaceId}/assets`)).assets;report.visualAssetIds=assets.filter(asset=>!initialAssets.includes(asset.id)).map(asset=>asset.id);
    report.cleanup.assetsRetainedForVisualVerification=report.visualAssetIds.length;
  }catch(error){report.cleanup.error=String(error.message).slice(0,160);process.exitCode=1;}
  writeFileSync(arg('--output'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({complete:report.complete,cases:report.cases.map(row=>({id:row.id,elapsedMs:row.elapsedMs,checks:row.checks})),cleanup:report.cleanup,error:report.error}));
}
