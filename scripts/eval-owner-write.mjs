import assert from 'node:assert/strict';
const logical=({version:_version,updatedAt:_updatedAt,...record})=>record;
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);

/** One write attempt, then authoritative receipt and full readback; never replay a write. */
export async function confirmedOwnerWrite(api,spaceId,body){
  assert(body.record?.id===spaceId&&body.requestId,'Invalid evaluation owner write scope');
  let writeError=null;
  try{await api(`/api/space/owner/canvases/${spaceId}`,'PUT',body);}catch(error){writeError=String(error.message);}
  const response=await api(`/api/space/spaces/${spaceId}/commands/${encodeURIComponent(body.requestId)}`);
  const entry=await api(`/api/space/owner/canvases/${spaceId}`);
  assert(response.receipt?.requestId===body.requestId&&response.receipt.status==='succeeded'
    &&response.receipt.version===entry.serverVersion
    &&canonical(logical(entry.record))===canonical(logical(body.record)),
  'Owner write not confirmed by its receipt and readback');
  return{entry,requestId:body.requestId,storageReceipt:response.receipt,recoveredAfterWriteError:writeError};
}
