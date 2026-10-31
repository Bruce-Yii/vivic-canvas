import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "./kokoro-manifest.json" with { type:"json" };
import { ensureArtifact, matchesArtifact } from "./artifacts.js";
import { LocalPythonRuntime, localRuntimeEnv, pinnedEngine } from "./pythonRuntime.js";
export interface LocalTtsStatus { phase:"absent"|"downloading"|"installing"|"cached"|"loading"|"ready"|"stopping"|"error"; enabled:boolean; model:string; downloadedBytes:number;totalBytes:number;error:string|null; voice:string; lastSynthesisFailure?: string | null; }
export function validateLocalWav(value:Uint8Array){
  const b=Buffer.from(value.buffer,value.byteOffset,value.byteLength);
  if(b.length<4844||b.length>2_160_044||b.toString("ascii",0,4)!=="RIFF"||b.toString("ascii",8,12)!=="WAVE"||b.toString("ascii",12,16)!=="fmt "||b.readUInt32LE(16)!==16||b.readUInt16LE(20)!==1||b.readUInt16LE(22)!==1||b.readUInt32LE(24)!==24000||b.readUInt32LE(28)!==48000||b.readUInt16LE(32)!==2||b.readUInt16LE(34)!==16||b.toString("ascii",36,40)!=="data"||b.readUInt32LE(40)!==b.length-44||b.readUInt32LE(4)!==b.length-8)throw new Error("invalid_local_audio");
  return value;
}
export class ManagedLocalTts {
  readonly root:string;
  private python:LocalPythonRuntime;
  private state:LocalTtsStatus={phase:"absent",enabled:false,model:"Kokoro v1.1 · Sherpa-ONNX",voice:"中文女声 · Kokoro 3",downloadedBytes:0,totalBytes:manifest.files.reduce((s,a)=>s+a.bytes,0),error:null};
  private operation?:AbortController;
  private task:Promise<unknown>=Promise.resolve();
  private closing:Promise<void>=Promise.resolve();
  private guardian?:ChildProcess;
  private generation=0;private serial=0;private cached=false;
  private pending?:{id:number;finish:(audio?:Uint8Array)=>void};
  constructor(root:string){this.root=root;this.python=new LocalPythonRuntime(path.join(root,"environment"));const generation=this.generation;void this.checkFiles().then(ok=>{if(generation===this.generation&&!this.operation){this.cached=ok;this.state.phase=ok?"cached":"absent";}});}
  status(){return {...this.state};}
  private get modelRoot(){return path.join(this.root,"kokoro");}
  private async checkFiles(){if(!await this.python.ready())return false;return (await Promise.all(manifest.files.map(a=>matchesArtifact(path.join(this.modelRoot,a.name),a)))).every(Boolean);}
  prepare(){
    if(this.operation||this.guardian)return this.status();if(!pinnedEngine()){this.state={...this.state,phase:"error",error:"本地语音支持 Windows x64 和 macOS arm64 / x64。"};return this.status();}
    const controller=new AbortController(),generation=++this.generation,previous=this.task;this.operation=controller;this.state={...this.state,phase:"downloading",enabled:false,error:null,downloadedBytes:0};
    this.task=(async()=>{try{await previous;await this.closing;controller.signal.throwIfAborted();let index=0;const progress=new Map<string,number>();
      const downloads=Array.from({length:6},async()=>{try{while(index<manifest.files.length){controller.signal.throwIfAborted();const a=manifest.files[index++]!,root=path.join(this.modelRoot,path.dirname(a.name));await ensureArtifact(root,{...a,name:path.basename(a.name)},AbortSignal.any([controller.signal,AbortSignal.timeout(20*60_000)]),n=>{progress.set(a.name,n);if(generation===this.generation)this.state.downloadedBytes=[...progress.values()].reduce((s,n)=>s+n,0);});}}catch(error){controller.abort();throw error;}});
      const results=await Promise.allSettled(downloads);if(results.some(r=>r.status==="rejected"))throw new Error("download_failed");
      this.state.phase="installing";await this.python.prepare(controller.signal);controller.signal.throwIfAborted();if(generation===this.generation){this.cached=true;this.state.phase="cached";}
    }catch{controller.abort();if(generation===this.generation)this.state={...this.state,phase:"error",error:"本地音色准备未完成，请检查网络和文件后重试。"};}
    finally{if(this.operation===controller)this.operation=undefined;}})();return this.status();
  }
  enable(){
    if(this.operation||this.guardian)return this.status();const controller=new AbortController(),generation=++this.generation,previous=this.task;this.operation=controller;this.state={...this.state,phase:"loading",enabled:true,error:null};
    this.task=(async()=>{try{await previous;await this.closing;controller.signal.throwIfAborted();if(!await this.checkFiles())throw new Error("not_prepared");
      const budget=AbortSignal.any([controller.signal,AbortSignal.timeout(120_000)]);
      const child=spawn(process.execPath,[fileURLToPath(new URL("./workerSupervisor.mjs",import.meta.url))],{env:localRuntimeEnv(),windowsHide:true,stdio:["ignore","ignore","ignore","ipc"]});this.guardian=child;
      const readiness=new Promise<void>((r,j)=>{const abort=()=>j(new Error("cancelled"));budget.addEventListener("abort",abort,{once:true});child.on("message",raw=>{const m=raw as {ready?:boolean;id?:number;wav?:string;error?:string;stage?:string};if(m.ready){budget.removeEventListener("abort",abort);r();}if(m.id===this.pending?.id){try{const b=typeof m.wav==="string"&&m.wav.length<3_000_000?validateLocalWav(Buffer.from(m.wav,"base64")):undefined;this.state.lastSynthesisFailure=b?null:["input_validation","phonemization_or_inference","audio_length","waveform_validation"].includes(m.stage??"")?m.stage:"worker_response";this.pending?.finish(b);}catch{this.state.lastSynthesisFailure="wav_validation";this.pending?.finish();}}});if(budget.aborted)abort();});
      child.once("error",()=>controller.abort());child.once("exit",()=>{if(this.guardian!==child)return;this.guardian=undefined;controller.abort();this.pending?.finish();if(generation===this.generation)this.state={...this.state,phase:"error",enabled:false,error:"本地语音进程已退出，可以重新启动。"};});
      child.send({kind:"start",executable:this.python.python,args:["-u",fileURLToPath(new URL("./localTtsWorker.py",import.meta.url))],setup:{root:this.modelRoot}},()=>{});await readiness;budget.throwIfAborted();if(generation===this.generation){this.cached=true;this.state.phase="ready";}
    }catch{if(generation===this.generation){this.terminate();this.state={...this.state,enabled:false,phase:"error",error:"本地语音未能加载，请先准备音色后重试。"};}}
    finally{if(this.operation===controller)this.operation=undefined;}})();return this.status();
  }
  async synthesize(text:string,speed=1,signal?:AbortSignal):Promise<Uint8Array>{
    if(typeof text!=="string"||!text.trim()||text.length>200||/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)||!Number.isFinite(speed)||speed<.5||speed>2)throw new Error("invalid_speech_input");
    if(this.state.phase!=="ready"||!this.guardian?.connected)throw new Error("local_tts_not_ready");if(this.pending)throw new Error("local_tts_busy");signal?.throwIfAborted();
    const generation=this.generation,budget=AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(60_000)]);
    const audio=await new Promise<Uint8Array|undefined>(resolve=>{const id=++this.serial;const abort=()=>{if(this.pending?.id===id){this.pending.finish();this.stop();}};const finish=(b?:Uint8Array)=>{if(this.pending?.id!==id)return;this.pending=undefined;budget.removeEventListener("abort",abort);resolve(b);};this.pending={id,finish};budget.addEventListener("abort",abort,{once:true});if(budget.aborted){abort();return;}this.guardian!.send({kind:"request",payload:{id,text:text.trim(),speed}},error=>{if(error)finish();});});
    if(generation!==this.generation||budget.aborted)throw new Error("local_tts_cancelled");if(!audio)throw new Error("local_tts_failed");return audio;
  }
  private terminate(){const child=this.guardian;this.guardian=undefined;this.pending?.finish();if(child&&child.exitCode===null&&child.signalCode===null){this.closing=new Promise<void>((r,j)=>{const t=setTimeout(()=>j(new Error("stop_timeout")),5000);child.once("exit",()=>{clearTimeout(t);r();});if(child.connected)child.disconnect();});void this.closing.catch(()=>{});}}
  stop(){const generation=++this.generation,active=Boolean(this.operation||this.guardian||this.state.phase==="stopping");this.operation?.abort();this.operation=undefined;this.terminate();this.state={...this.state,enabled:false,phase:active?"stopping":this.cached?"cached":"absent",error:null};this.task=Promise.all([this.task,this.closing]).then(()=>{if(generation===this.generation)this.state.phase=this.cached?"cached":"absent";}).catch(()=>{if(generation===this.generation)this.state={...this.state,phase:"error",error:"语音进程尚未完全停止，请重试。"};});return this.status();}
  clear(){this.stop();this.cached=false;const controller=new AbortController(),generation=this.generation;this.operation=controller;this.state.phase="installing";this.task=this.task.then(async()=>{for(const a of manifest.files){controller.signal.throwIfAborted();await fs.rm(path.join(this.modelRoot,a.name),{force:true});}if(generation===this.generation)this.state.phase="absent";}).catch(()=>{if(generation===this.generation)this.state={...this.state,phase:"error",error:"音色清理未完成，请重试。"};}).finally(()=>{if(this.operation===controller)this.operation=undefined;});return this.status();}
}
