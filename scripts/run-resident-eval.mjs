/** Repeatable Mac benchmark handoff. Uses the existing pinned SSH runner; no keys. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const repo=resolve(import.meta.dirname,'..');
const args=process.argv.slice(2),checkOnly=args.includes('--check');
const python=process.env.VIVIC_SSH_PYTHON||(process.platform==='win32'?join(process.env.LOCALAPPDATA,'Programs/Python/Python312/python.exe'):'python3');
const runner=process.env.VIVIC_MAC_SSH_RUNNER||resolve(repo,'../tools/macssh.py');
const stamp=new Date().toISOString().replaceAll(/[-:.]/g,'').slice(0,15);
const output=resolve(args.find(value=>value!=='--check')||join(repo,'evals/decision/results',`resident-${stamp}.json`));
const source=readFileSync(join(repo,'evals/decision/resident_eval.py'),'utf8');
const dataset=JSON.parse(readFileSync(join(repo,'evals/decision/dataset.json'),'utf8'));
const name=`resident-${stamp}.json`;
const remote=`import pathlib,sys,subprocess,hashlib,json,time,urllib.request,base64
lab=pathlib.Path.home()/'vivic-decision-lab'
with urllib.request.urlopen('http://127.0.0.1:19095/health',timeout=10) as response: health=json.load(response)
if not health.get('loaded') or health.get('paused_for_large_model'): raise RuntimeError('Resident model is not ready; wait for the normal release of any large-model lease')
expected=json.loads(base64.b64decode(${JSON.stringify(Buffer.from(JSON.stringify(dataset),'utf8').toString('base64'))}))
source=base64.b64decode(${JSON.stringify(Buffer.from(source,'utf8').toString('base64'))}).decode('utf8')
local=json.loads((lab/'dataset.json').read_text())
if expected!=local: raise RuntimeError('Frozen dataset changed; sync explicitly before evaluation')
sha=hashlib.sha256(json.dumps(expected,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
if ${checkOnly?'True':'False'}:
 compile(source,'resident_eval_g.py','exec')
 print(json.dumps({'ready':True,'dataset_sha256':sha,'cases':len(expected['cases']),'source_compiles':True}))
 raise SystemExit(0)
target=lab/'resident_eval_g.py'
if target.exists(): target.with_name(target.name+'.bak-'+time.strftime('%Y%m%dT%H%M%S')).write_bytes(target.read_bytes())
target.write_text(source,encoding='utf8')
python=pathlib.Path.home()/'Library/Application Support/VivicModelAPI/runtime/venv-next/bin/python'
raise SystemExit(subprocess.run([str(python),str(target),'--dataset-sha256',sha,'--output',str(lab/'results'/${JSON.stringify(name)})]).returncode)
`;
await new Promise((yes,no)=>{const child=spawn(python,['-I',runner],{stdio:['pipe','inherit','inherit']});child.on('error',no);child.on('exit',status=>status===0?yes():no(Error('Resident benchmark failed')));child.stdin.end(remote);});
if(checkOnly)process.exit(0);
const fetched=spawnSync(python,['-I',runner],{input:`from pathlib import Path\nprint((Path.home()/'vivic-decision-lab/results'/${JSON.stringify(name)}).read_text())\n`,encoding:'utf8',maxBuffer:4*1024*1024,timeout:30000});
if(fetched.status!==0)throw Error('Could not retrieve the benchmark result');
const result=JSON.parse(fetched.stdout);if(!result.complete)throw Error('Benchmark result is incomplete');
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({saved:output,cases:result.rows.length,summary:result.summary,sameEngine:result.same_engine}));
