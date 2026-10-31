import { ONLINE_BUILD } from "../../online/mode";
const MAX_BYTES = 2_160_044;
/** Only the local API's bounded PCM16 WAV format; never accept HTML, MP3 or arbitrary paths. */
export function validateLocalSpeechWav(bytes:Uint8Array) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),word=(start:number)=>String.fromCharCode(...bytes.subarray(start,start+4));
  if(bytes.length<4844||bytes.length>MAX_BYTES||word(0)!=="RIFF"||word(8)!=="WAVE"||word(12)!=="fmt "||view.getUint32(16,true)!==16||view.getUint16(20,true)!==1||view.getUint16(22,true)!==1||view.getUint32(24,true)!==24000||view.getUint32(28,true)!==48000||view.getUint16(32,true)!==2||view.getUint16(34,true)!==16||word(36)!=="data"||view.getUint32(40,true)!==bytes.length-44||view.getUint32(4,true)!==bytes.length-8)throw new Error("本地语音返回的音频格式无效。");
}
export async function synthesizeLocalSpeech(text:string,speed:number,signal:AbortSignal):Promise<Response> {
  if(ONLINE_BUILD)throw new Error("本地语音需要在电脑启动器中使用。");
  const response=await fetch("/api/local-tts/synthesize",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text,speed}),cache:"no-store",redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(60_000)])});
  if(!response.ok){const raw:unknown=await response.json().catch(()=>null);throw new Error(raw&&typeof raw==="object"&&"error" in raw&&typeof raw.error==="string"?raw.error.slice(0,160):"本地语音暂不可用，文字内容仍然保留。");}
  if(response.headers.get("content-type")?.split(";")[0]!=="audio/wav"||!response.body)throw new Error("本地语音返回的音频格式无效。");
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  try{while(true){signal.throwIfAborted();const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>MAX_BYTES)throw new Error("本地语音超过时长限制。");chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}validateLocalSpeechWav(bytes);signal.throwIfAborted();
  return new Response(bytes,{headers:{"content-type":"audio/wav","cache-control":"no-store"}});
}
