import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { freemem, totalmem } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
async function memorySnapshot(){
 const totalBytes=totalmem(),freeBytes=freemem();
 const snapshot={totalBytes,freeBytes,availableBytes:Math.min(totalBytes,freeBytes),source:"node-os-freemem"};
 if(process.platform!=="darwin")return snapshot;
 try{
  const {stdout}=await promisify(execFile)("/usr/bin/vm_stat",[],{timeout:3000,maxBuffer:65536,env:{...process.env,LC_ALL:"C"}});
  const pageSize=Number(stdout.match(/page size of (\d+) bytes/)?.[1]);
  const pages=Object.fromEntries(["free","inactive","speculative"].map(name=>[name,Number(stdout.match(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?$`,"m"))?.[1])]));
  if(!Number.isSafeInteger(pageSize)||pageSize<=0||Object.values(pages).some(n=>!Number.isSafeInteger(n)||n<0))throw Error("invalid_vm_stat");
  // Inactive file-backed/cache pages can be reclaimed; purgeable pages overlap
  // other counters and must not be added again. Keep the raw Node figure too.
  return {...snapshot,availableBytes:Math.min(totalBytes,Object.values(pages).reduce((sum,n)=>sum+n,0)*pageSize),source:"macos-vm_stat-free-inactive-speculative",pageSize,pages};
 }catch{return {...snapshot,source:"node-os-freemem-fallback"};}
}
if(!(process.platform==="win32"&&process.arch==="x64"||process.platform==="darwin"&&["arm64","x64"].includes(process.arch)))throw Error("Run on native Windows x64 or macOS arm64/x64; no emulated success is recorded.");
const usage="Usage: node scripts/verify-local-runtime.mjs [--tts] [--profile startlux-0.8b|startlux-2b|startlux-4b|startlux-9b] [--prepare-only] [--cache .cache/<directory>]";
const args=process.argv.slice(2),seen=new Set();
let ttsRequested=false,prepareOnly=false,profileId="startlux-0.8b",cacheArgument;
for(let i=0;i<args.length;i++){
 const flag=args[i];if(seen.has(flag))throw Error(usage);seen.add(flag);
 if(flag==="--tts")ttsRequested=true;
 else if(flag==="--prepare-only")prepareOnly=true;
 else if(flag==="--profile"||flag==="--cache"){
  const value=args[++i];if(!value||value.startsWith("--"))throw Error(usage);
  if(flag==="--profile")profileId=value;else cacheArgument=value;
 }else throw Error(usage);
}
if(!["startlux-0.8b","startlux-2b","startlux-4b","startlux-9b"].includes(profileId)||prepareOnly&&ttsRequested)throw Error(usage);
const cache=path.resolve(root,cacheArgument??`.cache/local-runtime-smoke-${process.platform}-${process.arch}`),allowed=path.resolve(root,".cache");
if(!cache.startsWith(allowed+path.sep))throw Error("Choose an isolated directory inside this workspace's .cache.");
await fs.mkdir(cache,{recursive:true});
const resolvedAllowed=await fs.realpath(allowed),resolvedCache=await fs.realpath(cache);
if(!resolvedCache.startsWith(resolvedAllowed+path.sep))throw Error("The cache must resolve inside this workspace's .cache.");
const require=createRequire(path.join(root,"apps/local-api/package.json"));
const {tsImport}=await import(pathToFileURL(require.resolve("tsx/esm/api")).href);
const {ManagedStartluxRuntime}=await tsImport(pathToFileURL(path.join(root,"apps/local-api/src/runtime/startluxRuntime.ts")).href,import.meta.url);
const {ManagedLocalTts}=await tsImport(pathToFileURL(path.join(root,"apps/local-api/src/runtime/localTts.ts")).href,import.meta.url);
const {STARTLUX_PROFILES}=await tsImport(pathToFileURL(path.join(root,"apps/local-api/src/runtime/startluxProfiles.ts")).href,import.meta.url);
const profile=STARTLUX_PROFILES.find(candidate=>candidate.id===profileId);
const decision=new ManagedStartluxRuntime(cache,profileId),tts=ttsRequested?new ManagedLocalTts(cache):undefined;
const evidence={started:new Date().toISOString(),platform:process.platform,arch:process.arch,profile:profileId,upstreamWeights:true,microphone:false,playback:false,prepareOnly,prepared:false,memory:await memorySnapshot(),events:[],decisions:[],audio:[],passed:false};
async function wait(runtime,target,timeout=30*60_000){const start=Date.now();let previous="",lastProgress=0;while(Date.now()-start<timeout){const status=runtime.status();if(status.phase!==previous){evidence.events.push({at:new Date().toISOString(),...status});console.info(`${status.model}: ${status.phase}`);previous=status.phase;lastProgress=Date.now();}else if(status.phase==="downloading"&&Date.now()-lastProgress>=15000){console.info(`${status.model}: ${status.downloadedBytes}/${status.totalBytes} bytes downloaded`);lastProgress=Date.now();}if(status.phase===target)return;if(status.phase==="error")throw Error(status.error);await new Promise(r=>setTimeout(r,500));}throw Error(`Runtime did not reach ${target}`);}
try {
 decision.prepare();await wait(decision,"cached");evidence.prepared=true;
 if(!prepareOnly){
 evidence.memory.beforeLoad=await memorySnapshot();
 evidence.memory.beforeLoadFreeBytes=evidence.memory.beforeLoad.freeBytes;
 if(evidence.memory.beforeLoad.totalBytes<profile.estimate.totalMemoryGiB*2**30||evidence.memory.beforeLoad.availableBytes<profile.estimate.freeMemoryGiB*2**30)throw Error(`Insufficient available memory for ${profileId}; prepared files retained, inference was not started.`);
 decision.enable();await wait(decision,"ready");
 for(const text of ["展开这张便笺","不要删除卡片"]){const result=await decision.decide(text);evidence.decisions.push({text,...result});if(["error","timeout","disabled","cancelled"].includes(result.state))throw Error("Native decision failed");}
 decision.stop();await wait(decision,"cached",15000);
 if(tts){tts.prepare();await wait(tts,"cached");tts.enable();await wait(tts,"ready");for(const [index,text] of ["先完成今天的优先清单。","会议行动项已经整理好了。"].entries()){const bytes=await tts.synthesize(text,1.05);const file=path.join(cache,`local-tts-${index}.wav`);await fs.writeFile(file,bytes);evidence.audio.push({file:path.basename(file),bytes:bytes.length,sampleRate:24000,sha256:createHash("sha256").update(bytes).digest("hex")});}if(evidence.audio[0].sha256===evidence.audio[1].sha256)throw Error("Distinct text unexpectedly produced identical audio");tts.stop();await wait(tts,"cached",15000);}
 evidence.passed=true;
 }
} catch(error) {
 evidence.error=error instanceof Error?error.message:String(error);throw error;
} finally {
 decision.stop();tts?.stop();evidence.finished=new Date().toISOString();await fs.writeFile(path.join(cache,"verification.json"),JSON.stringify(evidence,null,2)+"\n");
}
console.info(`${prepareOnly?"Native preparation complete; inference not run":"Native verification passed"}; evidence: ${path.join(cache,"verification.json")}`);
