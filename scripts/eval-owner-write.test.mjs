import {test} from 'node:test';
import assert from 'node:assert/strict';
import {confirmedOwnerWrite} from './eval-owner-write.mjs';
const body={record:{id:'evaluation-space',version:2,updatedAt:'2026-10-30T00:00:00Z',cardsById:{demo:{text:'one genuine proposal'}},cardOrder:['demo']},expectedVersion:1,requestId:'evaluation-write-1'};

test('recovers a committed write after ECONNRESET without sending it twice',async()=>{
  const calls=[];
  const api=async(path,method='GET')=>{calls.push({path,method});if(method==='PUT')throw Error('read ECONNRESET');if(path.includes('/commands/'))return{receipt:{requestId:body.requestId,status:'succeeded',version:2}};return{serverVersion:2,record:structuredClone(body.record)};};
  const result=await confirmedOwnerWrite(api,'evaluation-space',body);
  assert.equal(result.recoveredAfterWriteError,'read ECONNRESET');assert.equal(calls.filter(call=>call.method==='PUT').length,1);assert.equal(calls.length,3);assert.equal(result.storageReceipt.status,'succeeded');
});
test('does not report success if the write was never committed',async()=>{
  let writes=0;
  const api=async(path,method='GET')=>{if(method==='PUT'){writes++;throw Error('connection reset');}if(path.includes('/commands/'))return{receipt:{requestId:body.requestId,status:'failed',version:1}};return{serverVersion:1,record:{...body.record,cardsById:{},cardOrder:[]}};};
  await assert.rejects(confirmedOwnerWrite(api,'evaluation-space',body),/not confirmed/);assert.equal(writes,1);
});
test('refuses a different readback even when a success receipt exists',async()=>{
  const api=async(path,method='GET')=>method==='PUT'?{}:path.includes('/commands/')?{receipt:{requestId:body.requestId,status:'succeeded',version:2}}:{serverVersion:2,record:{...body.record,cardsById:{demo:{text:'different content'}}}};
  await assert.rejects(confirmedOwnerWrite(api,'evaluation-space',body),/not confirmed/);
});
test('rejects a cross-space write before contacting storage',async()=>{
  let called=false;await assert.rejects(confirmedOwnerWrite(async()=>{called=true;},'another-space',body),/scope/);assert.equal(called,false);
});
