/** Read-only demo readiness: a healthy HTTP server alone does not mean 4B is loaded. */
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const repo=resolve(import.meta.dirname,'..');
const python=process.env.VIVIC_SSH_PYTHON||(process.platform==='win32'?join(process.env.LOCALAPPDATA,'Programs/Python/Python312/python.exe'):'python3');
const runner=process.env.VIVIC_MAC_SSH_RUNNER||resolve(repo,'../tools/macssh.py');
const code='import json,urllib.request\nwith urllib.request.urlopen("http://127.0.0.1:19095/health",timeout=10) as response: print(json.dumps(json.load(response)))\n';
const result=spawnSync(python,['-I',runner],{input:code,encoding:'utf8',timeout:30000,maxBuffer:65536});
let decision=null,website=null,reason;
try{if(result.status!==0)throw Error('Model host health check unavailable');decision=JSON.parse(result.stdout);}catch(error){reason=error.message;}
try{const response=await fetch('https://vivic.edsionc.top/healthz',{signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Website health status '+response.status);website=await response.json();}catch(error){reason=reason||error.message;}
const ready=website?.ok===true&&decision?.ok===true&&decision?.loaded===true&&decision?.paused_for_large_model!==true;
if(!ready&&!reason)reason=decision?.paused_for_large_model?'Large-model memory lease is active; wait for its normal release before running the decision benchmark.':'Resident decision model is not loaded.';
console.log(JSON.stringify({at:new Date().toISOString(),ready,website,decision,...(reason?{reason}:{})},null,2));
if(!ready)process.exitCode=2;
