import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freemem, totalmem } from "node:os";
import { ensureArtifact, installedEngine, installEngine, matchesArtifact, type Artifact } from "./artifacts.js";
import { LocalPythonRuntime, localRuntimeEnv, pinnedEngine, STARTLUX_SOURCE, extractStartluxSource } from "./pythonRuntime.js";
import metadata from "./startlux-metadata.json" with { type: "json" };
import { STARTLUX_PROFILES, recommendStartluxProfile, type StartluxProfileId } from "./startluxProfiles.js";
import { parseStartluxPrediction, startluxRequest, type DecisionProvider, type DecisionProviderResult } from "../decision/provider.js";
import type { DecisionRuntimeControls, LocalRuntimeStatus } from "./decisionRuntime.js";
import { parseNativeAnswers, type NativeQuestion, type NativeResult } from "../decision/nativeV2.js";
import { resourceBudget, sampleResources, type ResourceSnapshot } from "./resources.js";

const busy = new Set(["downloading", "installing", "loading", "stopping"]);
async function freePort() { const s=createServer(); await new Promise<void>((r,j)=>{s.once("error",j);s.listen(0,"127.0.0.1",r);});const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port; }
const pause=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(t);reject(new Error("cancelled"));};const t=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},ms);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();});
export class ManagedStartluxRuntime implements DecisionProvider {
  readonly root:string;
  readonly controls: DecisionRuntimeControls = this;
  private profileId: StartluxProfileId;
  private operation?: AbortController;
  private task: Promise<unknown> = Promise.resolve();
  private guardian?: ChildProcess;
  private closing: Promise<void> = Promise.resolve();
  private generation=0;
  private serial=0;
  private pending?: {id:number;finish:(value:DecisionProviderResult)=>void};
  private nativePending?: {id:number;finish:(value:NativeResult)=>void;questions:Record<string,NativeQuestion>};
  private readonly contextLength: 2048 | 8192;
  private workerReady?: ()=>void;
  private cached=false;
  private python:LocalPythonRuntime;
  private engine=pinnedEngine();
  private state:LocalRuntimeStatus;
  private resources: ResourceSnapshot = { totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), basis: "os-available", sampledAt: Date.now() };
  private readonly memoryProbe: typeof sampleResources;
  constructor(root:string, profileId?:StartluxProfileId, options: { contextLength?: 2048 | 8192; memoryProbe?: typeof sampleResources } = {}) {
    this.root=root;
    this.contextLength=options.contextLength??2048;
    this.memoryProbe=options.memoryProbe??sampleResources;
    this.profileId=profileId ?? recommendStartluxProfile({totalMemoryBytes:totalmem(),freeMemoryBytes:freemem()}).profileId ?? "startlux-0.8b";
    this.python=new LocalPythonRuntime(path.join(root,"environment"));
    this.state={mode:"managed",phase:"absent",enabled:false,model:this.profile.label,bytes:this.profile.gguf.bytes,gpuBytes:0,error:null,downloadedBytes:0,totalBytes:this.totalBytes,scoreSource:"official-startlux-instant-bidirectional-letter-readout"};
    const generation=this.generation;
    void this.checkFiles().then(ok=>{if(generation===this.generation&&!this.operation){this.cached=ok;this.state.phase=ok?"cached":"absent";}});
  }
  private get profile(){return STARTLUX_PROFILES.find(p=>p.id===this.profileId)!;}
  private get modelRoot(){return path.join(this.root,this.profileId);}
  private get modelMetadata(){return metadata[this.profile.label.match(/v1\.1-(.*)-Instant/)![1] as keyof typeof metadata] as Artifact[];}
  private get totalBytes(){return this.profile.gguf.bytes+this.modelMetadata.reduce((s,a)=>s+a.bytes,0)+(this.engine?.bytes??0)+STARTLUX_SOURCE.bytes;}
  async refreshResources() { this.resources = await this.memoryProbe(); return resourceBudget(this.profile, this.resources); }
  status(){return {...this.state,resources:resourceBudget(this.profile,this.resources),profileId:this.profileId,engine:"llama.cpp b11550 · CPU",license:"CC-BY-NC-4.0",training:"base-upstream"};}
  selectProfile(id:string){
    if(!STARTLUX_PROFILES.some(p=>p.id===id))throw new Error("invalid_profile");
    if(this.operation||this.guardian||busy.has(this.state.phase))throw new Error("runtime_busy");
    this.profileId=id as StartluxProfileId;this.cached=false;const generation=++this.generation;
    this.state={...this.state,phase:"absent",enabled:false,model:this.profile.label,bytes:this.profile.gguf.bytes,totalBytes:this.totalBytes,downloadedBytes:0,error:null};
    void this.checkFiles().then(ok=>{if(generation===this.generation&&!this.operation){this.cached=ok;this.state.phase=ok?"cached":"absent";}});
    return this.status();
  }
  private async checkFiles(){
    if(!this.engine||!await this.python.ready()||!await installedEngine(this.root,this.engine))return false;
    if(!await matchesArtifact(path.join(this.root,STARTLUX_SOURCE.name),STARTLUX_SOURCE))return false;
    try {const receipt=JSON.parse(await fs.readFile(path.join(this.python.source,"receipt.json"),"utf8"));
      if(!receipt["startlux_decide/pipeline.py"])return false;
      for(const [name,a] of Object.entries(receipt)){
        if(name.split("/").some(s=>s===".."||!s)||!await matchesArtifact(path.join(this.python.source,name),a as Artifact))return false;
      }
    }catch{return false;}
    return (await Promise.all([this.profile.gguf,...this.modelMetadata].map(a=>matchesArtifact(path.join(this.modelRoot,a.name),a)))).every(Boolean);
  }
  prepare(){
    if(this.operation||this.guardian)return this.status();
    if(!this.engine){this.state={...this.state,phase:"error",error:"本地模型支持 Windows x64 和 macOS arm64 / x64。"};return this.status();}
    const controller=new AbortController(),generation=++this.generation,previous=this.task;this.operation=controller;
    this.state={...this.state,phase:"downloading",enabled:false,error:null,downloadedBytes:0};
    this.task=(async()=>{try{
      await previous;await this.closing;controller.signal.throwIfAborted();
      const disk=await fs.statfs(path.dirname(this.root)).catch(()=>null);
      if(disk&&Number(disk.bavail)*Number(disk.bsize)<this.totalBytes*2+1024**3)throw new Error("disk_space");
      let downloaded=0;
      for(const [root,a] of [[this.root,this.engine],[this.root,STARTLUX_SOURCE],...[this.profile.gguf,...this.modelMetadata].map(a=>[this.modelRoot,a])] as [string,Artifact][]){
        await ensureArtifact(root,a,AbortSignal.any([controller.signal,AbortSignal.timeout(20*60_000)]),n=>{if(generation===this.generation)this.state.downloadedBytes=downloaded+n;});downloaded+=a.bytes;
      }
      this.state.phase="installing";await installEngine(this.root,controller.signal,this.engine!);
      await extractStartluxSource(path.join(this.root,STARTLUX_SOURCE.name),this.python.source,controller.signal);
      await this.python.prepare(controller.signal);
      controller.signal.throwIfAborted();if(generation===this.generation){this.cached=true;this.state.phase="cached";}
    }catch(error){if(generation===this.generation)this.state={...this.state,phase:"error",error:error instanceof Error&&error.message==="disk_space"?"可用磁盘不足，请释放空间后重试。":"准备未完成，请检查网络或文件完整性后重试。"};}
    finally{if(this.operation===controller)this.operation=undefined;}})();
    return this.status();
  }
  enable(){
    if(this.operation||this.guardian)return this.status();
    const controller=new AbortController(),generation=++this.generation,previous=this.task;this.operation=controller;
    this.state={...this.state,phase:"loading",enabled:true,error:null};
    this.task=(async()=>{try{
      await previous;await this.closing;controller.signal.throwIfAborted();
      if (!(await this.refreshResources()).allowed) throw new Error("insufficient_resources");
      if(!await this.checkFiles())throw new Error("not_prepared");
      // File integrity checks may take seconds. Re-sample immediately before spawning.
      if (!(await this.refreshResources()).allowed) throw new Error("insufficient_resources");
      controller.signal.throwIfAborted();
      const budget=AbortSignal.any([controller.signal,AbortSignal.timeout(180_000)]),port=await freePort(),key=randomBytes(32).toString("base64url");budget.throwIfAborted();
      const env=localRuntimeEnv();
      const child=spawn(process.execPath,[fileURLToPath(new URL("./startluxSupervisor.mjs",import.meta.url))],{env,windowsHide:true,stdio:["ignore","ignore","ignore","ipc"]});this.guardian=child;
      child.on("message",raw=>{const m=raw as {ready?:boolean;id?:number;result?:unknown;error?:string;errorType?:string};if(m.ready)this.workerReady?.();if(m.id===this.pending?.id)this.pending?.finish(m.error?{state:"error",reason:"readout_failed"}:parseStartluxPrediction(m.result,this.activeText));if(m.id===this.nativePending?.id)this.nativePending?.finish(m.error?{ok:false,reason:["TimeoutError","ClientResponseError","RequestError","BackendRequestError","BackendError"].includes(m.errorType??"")?`readout_failed:${m.errorType}`:"readout_failed"}:parseNativeAnswers(m.result,this.nativePending.questions));});
      child.once("error",()=>controller.abort());child.once("exit",()=>{if(this.guardian!==child)return;this.guardian=undefined;controller.abort();this.pending?.finish({state:"error",reason:"runtime_exited"});this.nativePending?.finish({ok:false,reason:"runtime_exited"});if(generation===this.generation)this.state={...this.state,phase:"error",enabled:false,error:"本地模型已退出，可以重新启动。"};});
      child.send({kind:"engine",executable:path.join(this.root,"engine",this.engine!.executable),args:["-m",path.join(this.modelRoot,this.profile.gguf.name),"--host","127.0.0.1","--port",String(port),"--ctx-size",String(this.contextLength),"--threads","4","--n-gpu-layers","0","--parallel","1","--ctx-checkpoints","0","-b",String(this.contextLength),"-ub",String(this.contextLength),"--no-webui","--log-disable"],env:{LLAMA_API_KEY:key,...(process.platform==="darwin"?{DYLD_LIBRARY_PATH:path.join(this.root,"engine")}:{} )}},()=>{});
      let healthy=false;while(!healthy){budget.throwIfAborted();try{const r=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.any([budget,AbortSignal.timeout(1500)]),headers:{authorization:`Bearer ${key}`}});healthy=r.ok;await r.body?.cancel();}catch{}if(!healthy)await pause(250,budget);}
      await new Promise<void>((resolve,reject)=>{const abort=()=>reject(new Error("cancelled"));budget.addEventListener("abort",abort,{once:true});this.workerReady=()=>{budget.removeEventListener("abort",abort);resolve();};child.send({kind:"worker",executable:this.python.python,args:["-u",fileURLToPath(new URL("./startluxWorker.py",import.meta.url))],env:{PYTHONPATH:this.python.source},config:{model:this.modelRoot,url:`http://127.0.0.1:${port}`,key,contextLength:this.contextLength}},()=>{});if(budget.aborted)abort();});
      this.workerReady=undefined;
      const warmup=await this.infer("显示所有卡片",budget);
      if(["error","timeout","cancelled"].includes(warmup.state))throw new Error("warmup_failed");
      budget.throwIfAborted();if(generation===this.generation){this.cached=true;this.state.phase="ready";}
    }catch(error){if(generation===this.generation){this.terminate();this.state={...this.state,phase:"error",enabled:false,error:error instanceof Error&&error.message==="insufficient_resources"?`可用资源不足或无法确认：此规格需要总内存 ${this.profile.estimate.totalMemoryGiB} GiB、可用内存 ${this.profile.estimate.freeMemoryGiB} GiB。释放内存后重试，或选择较小规格。`:"启动或双向推理检查未通过，请先准备模型再重试。"};}}
    finally{this.workerReady=undefined;if(this.operation===controller)this.operation=undefined;}})();return this.status();
  }
  private activeText="";
  private infer(text:string,signal:AbortSignal):Promise<DecisionProviderResult>{
    if(this.pending||this.nativePending||!this.guardian?.connected)return Promise.resolve({state:"error",reason:"runtime_busy"});
    return new Promise(resolve=>{const id=++this.serial;this.activeText=text;const abort=()=>this.pending?.id===id&&this.pending.finish({state:"cancelled"});
      const finish=(v:DecisionProviderResult)=>{if(this.pending?.id!==id)return;this.pending=undefined;signal.removeEventListener("abort",abort);resolve(v);};
      this.pending={id,finish};signal.addEventListener("abort",abort,{once:true});if(signal.aborted){abort();return;}
      this.guardian!.send({kind:"request",id,payload:startluxRequest(text)},error=>{if(error)finish({state:"error",reason:"runtime_transport"});});});
  }
  async decide(text:string,signal?:AbortSignal):Promise<DecisionProviderResult>{
    if(signal?.aborted)return {state:"cancelled"};if(!this.state.enabled||this.state.phase!=="ready")return {state:"disabled"};if(!text.trim()||text.length>500)return {state:"deferred",reason:"input_limit"};
    const generation=this.generation,started=performance.now(),budget=AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(10_000)]);
    const result=await this.infer(text,budget);
    if(budget.aborted){this.stop();return {state:signal?.aborted?"cancelled":"timeout",reason:"local_readout_cancelled"};}
    return generation===this.generation?{...result,provider:"local",latencyMs:performance.now()-started}:{state:"cancelled"};
  }
  /** Explicit v2 adapter for real native questions; legacy inference keeps its seven labels. */
  async decideNative(state:unknown,questions:Record<string,NativeQuestion>,signal?:AbortSignal):Promise<NativeResult>{
    if(signal?.aborted)return {ok:false,reason:"cancelled"};
    if(!this.state.enabled||this.state.phase!=="ready")return {ok:false,reason:"runtime_not_ready"};
    if(this.pending||this.nativePending||!this.guardian?.connected)return {ok:false,reason:"runtime_busy"};
    if(!Object.keys(questions).length||Object.values(questions).some(q=>Object.keys(q.criteria).length>32))return {ok:false,reason:"candidate_limit"};
    const payload={state,questions,think_mode:"never",allow_none:true,none_check:true,return_details:false,return_thought:false};
    if(Buffer.byteLength(JSON.stringify(payload),"utf8")>120*1024)return {ok:false,reason:"request_limit"};
    const budget=AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(30_000)]);
    const result=await new Promise<NativeResult>(resolve=>{const id=++this.serial;
      const abort=()=>this.nativePending?.id===id&&this.nativePending.finish({ok:false,reason:signal?.aborted?"cancelled":"native_timeout"});
      const finish=(value:NativeResult)=>{if(this.nativePending?.id!==id)return;this.nativePending=undefined;budget.removeEventListener("abort",abort);resolve(value);};
      this.nativePending={id,finish,questions};budget.addEventListener("abort",abort,{once:true});if(budget.aborted){abort();return;}
      this.guardian!.send({kind:"request",id,payload},error=>{if(error)finish({ok:false,reason:"runtime_transport"});});
    });
    if(budget.aborted)this.stop();
    return result;
  }
  private terminate(){
    const child=this.guardian;this.guardian=undefined;this.pending?.finish({state:"cancelled"});this.nativePending?.finish({ok:false,reason:"cancelled"});
    if(child&&child.exitCode===null&&child.signalCode===null){this.closing=new Promise<void>((r,j)=>{const timer=setTimeout(()=>j(new Error("stop_timeout")),5000);child.once("exit",()=>{clearTimeout(timer);r();});if(child.connected)child.disconnect();});void this.closing.catch(()=>{});}
  }
  stop(){const generation=++this.generation,active=Boolean(this.operation||this.guardian||busy.has(this.state.phase));this.operation?.abort();this.operation=undefined;this.terminate();
    this.state={...this.state,enabled:false,phase:active?"stopping":this.cached?"cached":"absent",error:null};
    this.task=Promise.all([this.task,this.closing]).then(()=>{if(generation===this.generation)this.state.phase=this.cached?"cached":"absent";}).catch(()=>{if(generation===this.generation)this.state={...this.state,phase:"error",error:"模型尚未完全停止，请重试。"};});return this.status();}
  clear(){this.stop();this.cached=false;const generation=this.generation,controller=new AbortController();this.operation=controller;this.state.phase="installing";
    this.task=this.task.then(async()=>{controller.signal.throwIfAborted();for(const a of [this.profile.gguf,...this.modelMetadata]){controller.signal.throwIfAborted();await fs.rm(path.join(this.modelRoot,a.name),{force:true});}if(generation===this.generation)this.state.phase="absent";}).catch(()=>{if(generation===this.generation)this.state={...this.state,phase:"error",error:"清理未完成，请重试。"};}).finally(()=>{if(this.operation===controller)this.operation=undefined;});return this.status();}
}
