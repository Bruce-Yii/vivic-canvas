import fs from 'node:fs';
import {GUIDES} from './documentation-guides.mjs';
import {PERMISSIONS,hasPermission,permissionInfo,requiredPermission} from './api-permissions.mjs';

const FILES=JSON.parse(fs.readFileSync(new URL('./documentation-capabilities.json',import.meta.url),'utf8'));
const failure=(status,message)=>Object.assign(Error(message),{status});
const metadata=new Set(['/models','/permissions','/docs','/docs.md']);
const extras=[
 ['GET','/capabilities','文件能力与限制'],['GET','/relation-predicates','预置关系词'],['POST','/files','上传文件'],['GET','/files/{id}/content','下载文件'],['DELETE','/files/{id}','删除文件'],['POST','/jobs','创建任务'],['GET','/jobs','近期任务'],['GET','/jobs/{id}','查询任务'],['POST','/jobs/{id}/cancel','取消任务'],
 ['GET','/audio/library/credits','音效署名清单'],['GET','/studio/voices/{id}','声音档案详情'],['GET','/studio/voices/{id}/audio','试听参考录音'],['PUT','/studio/voices/{id}','更新声音'],['DELETE','/studio/voices/{id}','删除声音'],['GET','/studio/history','工作室历史'],['GET','/studio/audio/{id}.wav','下载工作室音频'],['POST','/studio/audio/transcriptions','工作室转写'],
].map(([method,path,capability])=>({method,path,capability,model:null,input:'见对应能力详细指南',output:'JSON 或文件，见对应小节'}));
function tableCell(value){return String(value??'—').replaceAll('|','\\|').replaceAll('\n',' ');}
const shellQuote=value=>"'"+String(value).replaceAll("'","'\"'\"'")+"'";
const binaryFile=g=>({'qwen3-tts':'speech.wav',birefnet:'transparent.png',rnnoise:'denoised.wav','voice-studio':'speech.wav','voice-design':'speech.wav'}[g.id]);
function pythonValue(value){
 if(value===null)return 'None';
 if(typeof value==='boolean')return value?'True':'False';
 if(Array.isArray(value))return '['+value.map(pythonValue).join(', ')+']';
 if(typeof value==='object')return '{'+Object.entries(value).map(([key,val])=>JSON.stringify(key)+': '+pythonValue(val)).join(', ')+'}';
 return JSON.stringify(value);
}
function pythonHeader(base){return `import os\nimport requests\n\nBASE = ${JSON.stringify(base)}\nheaders = {"Authorization": "Bearer " + os.environ["VIVIC_API_KEY"]}\n`;}
function fileWorkflow(g,base){
 const operation=g.operation||'image.process';
 const options=operation==='image.relations'?{boxes:[[0,0,100,100],[100,0,200,100]],predicates:['on','next to'],top_k:10}:{format:'webp',width:1280,quality:85};
 return pythonHeader(base)+`import time\n\nwith open("input.png", "rb") as f:\n    r = requests.post(BASE + "/files", headers=headers, files={"file": f}, timeout=120)\nr.raise_for_status()\nfile_id = r.json()["id"]\n\nr = requests.post(BASE + "/jobs", headers=headers, json={\n    "operation": ${JSON.stringify(operation)},\n    "inputs": [file_id],\n    "options": ${JSON.stringify(options)}\n}, timeout=30)\nr.raise_for_status()\njob_id = r.json()["id"]\n\ndeadline = time.monotonic() + 660\nwhile True:\n    r = requests.get(BASE + "/jobs/" + job_id, headers=headers, timeout=30)\n    r.raise_for_status()\n    job = r.json()\n    if job["status"] in {"succeeded", "failed", "cancelled"}:\n        break\n    if time.monotonic() > deadline:\n        raise TimeoutError("Task did not finish before the client deadline")\n    time.sleep(2)\n\nif job["status"] != "succeeded":\n    raise RuntimeError(job.get("error") or job["status"])\noutput = job["outputs"][0]\nr = requests.get(BASE + "/files/" + output["id"] + "/content", headers=headers, timeout=120)\nr.raise_for_status()\nwith open(${JSON.stringify(operation==='image.relations'?'relations.json':'result.webp')}, "wb") as f:\n    f.write(r.content)\n`;
}
function audioWorkflow(base){
 return pythonHeader(base)+`\n# Use kind="sfx" for sound effects; use kind="bgm" for music.\nr = requests.get(BASE + "/audio/library", headers=headers,\n    params={"kind": "bgm", "q": "cozy", "limit": 1}, timeout=30)\nr.raise_for_status()\nassets = r.json()["data"]\nif not assets:\n    raise SystemExit("No matching audio")\nasset = assets[0]\n\nr = requests.get(BASE + "/audio/library/" + asset["id"] + "/content",\n    headers=headers, timeout=120)\nr.raise_for_status()\nwith open("music." + asset["format"], "wb") as f:\n    f.write(r.content)\nprint(asset["attribution"])\n`;
}
export function examplesFor(g,base){
 let url=base+g.path;
 if(g.request.query)url+='?'+new URLSearchParams(g.request.query);
 const timeout=g.permission==='chat_qwen38'?620:g.permission==='studio'?360:180;
 const args=[`export VIVIC_API_KEY='YOUR_API_KEY'`,`curl --fail-with-body --silent --show-error --max-time ${timeout} ${shellQuote(url)} \\\n  -H "Authorization: Bearer $VIVIC_API_KEY"`];
 if(g.request.json)args[1]+=` \\\n  -H 'Content-Type: application/json' \\\n  -d ${shellQuote(JSON.stringify(g.request.json))}`;
 if(g.request.form)for(const [name,value]of Object.entries(g.request.form))args[1]+=` \\\n  -F ${shellQuote(name+'='+value)}`;
 const output=binaryFile(g);if(output)args[1]+=` \\\n  -o ${output}`;
 let python;
 if(g.workflow==='audio')python=audioWorkflow(base);
 else if(g.workflow==='files')python=fileWorkflow(g,base);
 else{
  python=pythonHeader(base)+'\n';
  let options='';
  if(g.request.query)options+=`, params=${JSON.stringify(g.request.query)}`;
  if(g.request.json)options+=`, json=${pythonValue(g.request.json)}`;
  if(g.request.form){
   const files=Object.entries(g.request.form).filter(([,v])=>v.startsWith('@'));
   const data=Object.fromEntries(Object.entries(g.request.form).filter(([,v])=>!v.startsWith('@')));
   python+='from contextlib import ExitStack\nwith ExitStack() as stack:\n';
   const fields=files.map(([name,file],i)=>{python+=`    f${i} = stack.enter_context(open(${JSON.stringify(file.slice(1))}, "rb"))\n`;return `${JSON.stringify(name)}: f${i}`;});
   python+=`    r = requests.post(BASE + ${JSON.stringify(g.path)}, headers=headers,\n        files={${fields.join(', ')}}, data=${JSON.stringify(data)}, timeout=${timeout})\n`;
  }else python+=`r = requests.${g.method.toLowerCase()}(BASE + ${JSON.stringify(g.path)}, headers=headers${options}, timeout=${timeout})\n`;
  python+='r.raise_for_status()\n';
  python+=output?`with open(${JSON.stringify(output)}, "wb") as f:\n    f.write(r.content)\n`:'print(r.json())\n';
 }
 return {curl:args.join('\n'),python};
}
export function buildDocumentation(core,{entry,query=new URLSearchParams()}={}){
 const capability=query.get('capability'),modelId=query.get('model');
 if(capability&&!PERMISSIONS.some(p=>p.id===capability))throw failure(400,'未知 capability；请使用文档中的权限 ID');
 if(modelId&&!GUIDES.some(g=>g.model_ids.includes(modelId)))throw failure(400,'未知 model；请使用文档列出的模型 ID');
 if(entry&&capability&&!hasPermission(entry,capability))throw failure(403,'此 Key 无权读取该能力的专属文档');
 let guides=GUIDES.filter(g=>(!entry||hasPermission(entry,g.permission))&&(!capability||g.permission===capability)&&(!modelId||g.model_ids.includes(modelId)));
 if(modelId&&!guides.length&&entry)throw failure(403,'此 Key 无权读取该模型的专属文档');
 const scopes=new Set(guides.map(g=>g.permission));
 const spec=structuredClone(core),originBase=core.baseURL.replace(/\/v1$/,'');
 spec.name='EC Studio API 使用文档';spec.updated='2026-10-30';
 spec.documentation_url=originBase+'/docs/';
 spec.public_json=originBase+'/docs.json';spec.public_markdown=originBase+'/docs.md';
 spec.selection={capability:capability||null,model:modelId||null};
 spec.notes=['业务请求携带 Authorization: Bearer <API Key>；公开文档无需密码或 Key。','客户端先设置 VIVIC_API_KEY 环境变量。示例中的数值与 ID 仅用于说明结构。','模型冷启动和排队计入耗时，默认建议 180 秒超时，Voice Studio 建议 360 秒。','Key 未获授权返回 403；无效、暂停或撤销返回 401。Key 不要放进 URL。'];
 spec.key_permissions.available=PERMISSIONS.filter(p=>scopes.has(p.id)).map(({models,...p})=>p);
 spec.endpoints=[...spec.endpoints,...extras].filter(e=>metadata.has(e.path)||scopes.has(requiredPermission('/v1'+e.path))).map(e=>({...e,permission:requiredPermission('/v1'+e.path)||null,...(modelId&&e.path==='/decisions'?{model:modelId}:{})}));
 spec.guides=guides.map(g=>({...structuredClone(g),examples:examplesFor(g,core.baseURL),share_url:originBase+'/docs/?'+new URLSearchParams(g.model_ids.length===1?{model:g.model_ids[0]}:{capability:g.permission})+'#'+g.id}));
 if(scopes.has('files'))spec.file_api=structuredClone(FILES);else delete spec.file_api;
 if(entry)spec.key_access=permissionInfo(entry);else delete spec.key_access;
 return spec;
}
export function documentationMarkdown(spec){
 const lines=[`# ${spec.name}`,'',`更新：${spec.updated}`,'',`在线文档：${spec.documentation_url}`,'',`Base URL：\`${spec.baseURL}\``,'',`认证：\`${spec.auth}\``,'',
  '## 获取文档','',`- 公开页面：${spec.documentation_url}`,`- 无需登录的 JSON：${spec.public_json}`,`- 无需登录的 Markdown：${spec.public_markdown}`,
  '- 用 Key 拉取：GET /v1/docs；下载：GET /v1/docs.md。使用平台完整地址 /api/v1/docs 与 /api/v1/docs.md，并携带 Bearer Key。内容按 Key 的权限筛选。',
  '- 可选查询：capability=audio_library 等权限 ID；model=qwen3-tts-1.7b 等模型 ID。公开页面也支持同样的查询参数。','',
  '## 接入约定','',...spec.notes.map(x=>'- '+x),'',
  '## API Key 权限','',spec.key_access?`当前 Key：${spec.key_access.all?'全部能力':spec.key_access.capabilities.map(p=>p.name).join('、')||'未授予业务能力'}。`:'由管理员为 Key 分配能力；新 Key 默认全部能力，也可以只勾选音效库等指定能力。',
  '默认全部权限为 ["*"]，指定权限使用能力 ID 数组。已有 Key 可在管理台修改，保存后对新请求生效。文档筛选不改变 Key 实际权限。','',
  ...spec.key_permissions.available.map(p=>`- \`${p.id}\`：${p.name} — ${p.description}`),'',
  '## 通用错误','', '| 状态 | 含义 |','| --- | --- |','| 400 / 422 | 参数、文件或 JSON 格式不正确 |','| 401 | Key 无效、已暂停或已撤销 |','| 403 | Key 未获授权使用该能力 |','| 404 | 素材、文件或任务不存在，或不属于该 Key |','| 409 | 状态冲突或重复任务参数不一致 |','| 413 | 文件或请求过大 |','| 429 | 频率或任务队列已满，稍后重试 |','| 503 | 服务暂不可用、模型推理或连接失败 |','',
 ];
 for(const g of spec.guides){
  lines.push(`## ${g.title}`,'',g.summary,'',`权限：\`${g.permission}\``,'',g.model_ids.length?'能力 / 模型 ID：'+g.model_ids.map(x=>'`'+x+'`').join('、'):'类型：素材库或文件任务','',`接口：\`${g.method} ${g.path}\`；请求格式：${g.format}`,'',`可分享链接：${g.share_url}`,'',
   '### 参数','','| 字段 | 类型 | 必填 | 默认 | 说明 |','| --- | --- | --- | --- | --- |',...g.parameters.map(p=>`| ${tableCell(p.name)} | ${tableCell(p.type)} | ${p.required?'是':'否'} | ${tableCell(typeof p.default==='object'?JSON.stringify(p.default):p.default)} | ${tableCell(p.description)} |`),'',
   '### curl','','```sh',g.examples.curl,'```','','### Python','','```python',g.examples.python,'```','','### 返回结果','',typeof g.response==='string'?g.response:'JSON 示例（ID 和数值仅示意）：\n\n```json\n'+JSON.stringify(g.response,null,2)+'\n```','',...g.notes.map(x=>'- '+x),'');
 }
 if(spec.file_api){lines.push('## 文件任务操作参数','','| operation | 能力 | options |','| --- | --- | --- |',...spec.file_api.operations.map(op=>`| ${op.id} | ${op.name} | ${tableCell(JSON.stringify(op.options))} |`),'');}
 lines.push('## 接口索引','','| 能力 | 方法 | 路径 | 权限 |','| --- | --- | --- | --- |',...spec.endpoints.map(e=>`| ${e.capability} | ${e.method} | ${e.path} | ${e.permission||'鉴权后的元数据'} |`),'');
 return lines.join('\n');
}
