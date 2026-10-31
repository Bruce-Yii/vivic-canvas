import {buildDocumentation,documentationMarkdown} from './documentation.mjs';
import {PERMISSIONS,normalizePermissions,effectivePermissions,enforcePermission,permissionInfo,filterModels} from './api-permissions.mjs';
import {createAudioLibrary} from './audio-library.mjs';
import http from 'node:http';
import net from 'node:net';
import {openVault} from './key-vault.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {fileURLToPath} from 'node:url';

const DIR=path.dirname(fileURLToPath(import.meta.url));
const CONFIG=JSON.parse(fs.readFileSync(process.env.VIVIC_GATEWAY_CONFIG||'/etc/vivic-model-api/config.json','utf8'));
const PREFIX='/api';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const stamp=()=>new Date().toISOString();
function passwordHash(password,salt=crypto.randomBytes(16).toString('hex')) {
 return {salt,hash:crypto.scryptSync(password,salt,64).toString('hex')};
}
function persist(value=state){
 const temporary=CONFIG.stateFile+'.tmp';
 fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600});fs.renameSync(temporary,CONFIG.stateFile);
}
if(process.argv.includes('--bootstrap')) {
 const file=process.argv[process.argv.indexOf('--bootstrap')+1];
 if(fs.existsSync(CONFIG.stateFile))throw Error('Existing gateway state will not be overwritten');
 const secrets=JSON.parse(fs.readFileSync(file,'utf8'));
 fs.mkdirSync(path.dirname(CONFIG.stateFile),{recursive:true,mode:0o700});
 persist({version:1,password:passwordHash(secrets.adminPassword),keys:[{
  id:crypto.randomUUID(),name:'内测测试 Key',prefix:secrets.apiKey.slice(0,12),
  hash:sha(secrets.apiKey),created:stamp(),revoked:false,requests:0,lastUsed:null
 }],recent:[]});
 console.log('Gateway initialized; credentials were not printed.');process.exit(0);
}
let state=JSON.parse(fs.readFileSync(CONFIG.stateFile,'utf8'));
state.version=3;
const vault=openVault(CONFIG.keyVaultFile||path.join(path.dirname(CONFIG.stateFile),'key-vault.key'),state.keys);
state.usage??={since:stamp(),timezone:'Asia/Shanghai',days:{}};
let activeInference=0;
const inferenceQueue=[];
function clientAddress(req){
 const raw=String(req.headers['x-real-ip']||req.socket.remoteAddress||'').split(',')[0].trim();
 return raw.replace(/^::ffff:/,'')||'未知';
}
const MODEL_ROUTES={
 '/v1/chat/completions':'qwen3.8-27b-iq4-xs',
 '/v1/audio/speech':'qwen3-tts-1.7b','/v1/audio/transcriptions':'qwen3-asr-1.7b','/v1/ocr':'apple-vision','/v1/embeddings':'qwen3-embedding-0.6b',
 '/v1/rerank':'qwen3-reranker-0.6b','/v1/images/match':'siglip2-base','/v1/images/remove-background':'birefnet-lite',
 '/v1/audio/vad':'silero-vad','/v1/audio/denoise':'rnnoise','/v1/audio/speakers/compare':'campplus-zh-en','/v1/decisions':'startlux-decision-2b'
};
function counter(){return {requests:0,success:0,errors:0,ms:0};}
function addUsage(route,status,ms,key,selectedModel){
 const date=new Date(Date.now()+8*3600000).toISOString().slice(0,10),model=selectedModel||MODEL_ROUTES[route];
 const day=state.usage.days[date]??={...counter(),models:{},keys:{}};
 const groups=[day,day.models[model]??=counter(),day.keys[key?.id||'console']??=counter()];
 for(const group of groups){group.requests++;group[status>=200&&status<300?'success':'errors']++;group.ms+=ms;}
 for(const old of Object.keys(state.usage.days))if(old<new Date(Date.now()+8*3600000-89*86400000).toISOString().slice(0,10))delete state.usage.days[old];
 if(key){key.requests++;key.lastUsed=stamp();}
 state.recent.push({at:stamp(),route,model,status,ms,key:key?.name||'管理台'});state.recent=state.recent.slice(-100);
 try{persist();}catch{console.error('usage_persist_failed');}
}
const sessions=new Map(),failures=new Map(),limits=new Map();
const cookieName='__Secure-vivic_model_session';
const staticFiles={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
for(const name of ['kimi-source-variables.css','kimi-components.css','kimi-controls.css','ecstudio.css'])staticFiles['/vendor/'+name]='vendor/'+name;
function error(status,message){return Object.assign(Error(message),{status});}
function json(res,status,value,headers={}) {
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));
}
async function body(req,max=8192) {
 const chunks=[];let length=0;
 for await(const chunk of req){length+=chunk.length;if(length>max)throw error(413,'请求过大');chunks.push(chunk);}
 return Buffer.concat(chunks);
}
async function readJSON(req,max=8192){try{return JSON.parse((await body(req,max)).toString('utf8'));}catch(e){if(e.status)throw e;throw error(400,'JSON 格式不正确');}}
function admin(req) {
 const value=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
 const entry=value?sessions.get(sha(value)):undefined;
 if(!entry||entry.expires<Date.now()){if(value)sessions.delete(sha(value));return false;}
 return true;
}
function sameOrigin(req) {
 if(req.headers.origin!==CONFIG.origin||req.headers['x-vivic-console']!=='1')throw error(403,'请从管理台执行此操作');
}
function keyAuth(req) {
 const token=/^Bearer (\S+)$/i.exec(req.headers.authorization||'')?.[1];
 const entry=token?state.keys.find(k=>!k.revoked&&!k.paused&&k.hash===sha(token)):undefined;
 if(!entry)throw error(401,'API key 无效、已暂停或已撤销');
 enforcePermission(entry,new URL(req.url,'http://localhost').pathname.slice(PREFIX.length));
 return entry;
}
function keyRate(entry){
 const bucket=limits.get(entry.id)||{start:Date.now(),count:0};
 if(Date.now()-bucket.start>60000){bucket.start=Date.now();bucket.count=0;}
 if(++bucket.count>60)throw error(429,'请求过快，请稍后重试');limits.set(entry.id,bucket);
 return entry;
}
async function worker(route,options={}) {
 return fetch(CONFIG.workerURL+route,{...options,
  headers:{...(options.headers||{}),Authorization:'Bearer '+CONFIG.workerToken},
  signal:options.signal||AbortSignal.timeout(180000)});
}
async function workerJSON(route){const response=await worker(route,{signal:AbortSignal.timeout(5000),headers:{'X-Vivic-Owner':'console'}});if(!response.ok)throw error(503,'Mac 模型服务暂不可用');return response.json();}
function publicKey(k){return {id:k.id,name:k.name,prefix:k.prefix,created:k.created,revoked:k.revoked,requests:k.requests,lastUsed:k.lastUsed,paused:!!k.paused,revealable:!!k.encryptedKey&&vault.ready,permissions:effectivePermissions(k)};}

async function consoleAPI(req,res,route) {
 if(route==='/login'&&req.method==='POST') {
  sameOrigin(req);const address=req.headers['x-real-ip']||req.socket.remoteAddress;
  let fail=failures.get(address)||{start:Date.now(),count:0};
  if(Date.now()-fail.start>15*60000)fail={start:Date.now(),count:0};
  if(fail.count>=8)throw error(429,'尝试次数过多，请15分钟后重试');
  const value=await readJSON(req);const password=typeof value.password==='string'?value.password:'';
  const valid=password.length<=200&&crypto.timingSafeEqual(Buffer.from(passwordHash(password,state.password.salt).hash,'hex'),Buffer.from(state.password.hash,'hex'));
  if(!valid){fail.count++;failures.set(address,fail);throw error(401,'密码不正确');}
  failures.delete(address);const token=crypto.randomBytes(32).toString('base64url');
  sessions.set(sha(token),{expires:Date.now()+6*3600000});
  return json(res,200,{ok:true},{'Set-Cookie':`${cookieName}=${token}; HttpOnly; Secure; SameSite=Strict; Path=${PREFIX}/; Max-Age=21600`});
 }
 if(!admin(req))throw error(401,'请先登录');
 if(req.method!=='GET')sameOrigin(req);
 if(route==='/session'&&req.method==='GET')return json(res,200,{ok:true});
 if(route==='/logout'&&req.method==='POST') {
  const value=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  if(value)sessions.delete(sha(value));
  return json(res,200,{ok:true},{'Set-Cookie':`${cookieName}=; HttpOnly; Secure; SameSite=Strict; Path=${PREFIX}/; Max-Age=0`});
 }
 if(route==='/permission-options'&&req.method==='GET')return json(res,200,{permissions:PERMISSIONS.map(({models,...x})=>x)});
 if(route==='/keys'&&req.method==='GET')return json(res,200,{keys:state.keys.map(publicKey)});
 if(route==='/usage'&&req.method==='GET')return json(res,200,await mergedUsage());
 if(route==='/keys'&&req.method==='POST') {
  const value=await readJSON(req);const name=typeof value.name==='string'?value.name.trim().slice(0,60):'';
  if(!name)throw error(400,'请输入 Key 名称');
  if(state.keys.filter(k=>!k.revoked).length>=30)throw error(400,'最多保留30个有效 Key');
  const permissions=normalizePermissions(value.permissions);
  const token='vvc_'+crypto.randomBytes(30).toString('base64url');
  const entry={id:crypto.randomUUID(),name,prefix:token.slice(0,12),hash:sha(token),created:stamp(),revoked:false,requests:0,lastUsed:null};
  if(!vault.ready)throw error(503,'Key加密存储暂不可用');
  entry.permissions=permissions;entry.paused=false;entry.encryptedKey=vault.seal(entry.id,token);
  state.keys.push(entry);persist();return json(res,201,{...publicKey(entry),key:token});
 }
 const action=/^\/keys\/([a-f0-9-]+)(?:\/(reveal|secret))?$/.exec(route);
 if(action&&['POST','PATCH'].includes(req.method)){
  const entry=state.keys.find(k=>k.id===action[1]);if(!entry)throw error(404,'Key不存在');if(entry.revoked)throw error(409,'Key已撤销');
  if(req.method==='PATCH'&&!action[2]){
   const value=await readJSON(req),fields=Object.keys(value);
   if(!fields.length||fields.some(x=>!['paused','permissions'].includes(x)))throw error(400,'只能更新 paused 或 permissions');
   if(Object.hasOwn(value,'paused')&&typeof value.paused!=='boolean')throw error(400,'paused必须为布尔值');
   const permissions=Object.hasOwn(value,'permissions')?normalizePermissions(value.permissions):undefined;
   if(permissions)entry.permissions=permissions;
   if(Object.hasOwn(value,'paused'))entry.paused=value.paused;
   recordKeyEvent(permissions?'permissions':value.paused?'pause':'resume',entry.id);
   return json(res,200,publicKey(entry));
  }
  if(req.method==='POST'&&action[2]==='reveal'){
   if(!entry.encryptedKey)throw error(409,'旧Key未保存原文，可补存已有原文');if(!vault.ready)throw error(503,'Key加密存储暂不可用');
   let key;try{key=vault.reveal(entry.id,entry.encryptedKey);}catch{throw error(503,'Key原文无法解密，请检查加密文件');}
   recordKeyEvent('reveal',entry.id);return json(res,200,{key});
  }
  if(req.method==='POST'&&action[2]==='secret'){
   const value=await readJSON(req);if(typeof value.key!=='string'||value.key.length>200||sha(value.key)!==entry.hash)throw error(400,'原Key不匹配');
   if(!vault.ready)throw error(503,'Key加密存储暂不可用');entry.encryptedKey=vault.seal(entry.id,value.key);recordKeyEvent('store',entry.id);return json(res,200,publicKey(entry));
  }
 }
 const revoke=/^\/keys\/([a-f0-9-]+)$/.exec(route);
 if(revoke&&req.method==='DELETE') {
  const entry=state.keys.find(k=>k.id===revoke[1]);if(!entry)throw error(404,'Key 不存在');entry.revoked=true;entry.paused=true;delete entry.encryptedKey;recordKeyEvent('revoke',entry.id);return json(res,200,{ok:true});
 }
 if(route==='/status'&&req.method==='GET') {
  let mac;
  try{mac=await workerJSON('/health');}catch{mac={ok:false,queue:0,models:[]};}
  return json(res,200,{ok:true,mac,baseURL:CONFIG.origin+PREFIX+'/v1',recent:state.recent.slice(-8).reverse(),queue:inferenceQueue.map(item=>({ip:item.ip,model:item.model}))});
 }
 throw error(404,'接口不存在');
}

function apiDocs(baseURL){
  return {
    name:'Vivic 模型 API',
    baseURL,
    auth:'Authorization: Bearer <API Key>',
    timeoutSeconds:180,
    pull:'GET /v1/docs',
    download:'GET /v1/docs.md',
    notes:[
      '聊天大模型继续使用你自己的 StepFun 或 DeepSeek Key。',
      '模型按需加载，冷启动和排队计入请求时间。收到 429 时稍后重试。',
      'Qwen3 TTS 没有独立的语速或停顿参数。用 instruct 描述语气；语速较慢写「语速放慢。」，语速较快写「语速稍快。」，紧凑写「少停顿，句子连起来说。」，多停顿写「在逗号和句号处多停顿。」',
      'SigLIP 分数和 CAM++ 相似度不能当作身份或分类概率。CAM++ 不提供完整多人分段。',
      'StartLux 权重为 CC-BY-NC-4.0，仅作内测评估，商业使用须另核许可。',
    ],
    limits:{speechCharacters:300,audioSeconds:60,audioMegabytes:20,uploadMegabytes:22,imageMegabytes:10,imagePixels:16000000},
    key_permissions:{default:['*'],available:PERMISSIONS.map(({models,...x})=>x),forbiddenStatus:403},
    endpoints:[
      {capability:'按需文本推理',method:'POST',path:'/chat/completions',model:'qwen3.8-27b-iq4-xs',input:'JSON model、messages、可选context_window/max_tokens；stream=false',output:'OpenAI格式ChatCompletion；本机单模型排队'},
      {capability:'当前Key权限',method:'GET',path:'/permissions',model:null,input:'现有Bearer Key',output:'permissions、all与可调用能力列表；不返回Key原文'},
      {capability:'音效与BGM搜索',method:'GET',path:'/audio/library',model:null,input:'q、kind=sfx/bgm/jingle/ambience、tag、theme、source、license、format、min_duration、max_duration、min_quality、sort=name/duration/-duration/quality、limit=1–100、offset',output:'total、data素材列表；包含id、时长、标签、作者、许可、content_url、preview_url；链接也需鉴权'},
      {capability:'音效库分类',method:'GET',path:'/audio/library/stats',model:null,input:'无',output:'类型、来源、主题、标签、授权与格式计数'},
      {capability:'音效详情',method:'GET',path:'/audio/library/{id}',model:null,input:'搜索结果中的id',output:'素材信息、原文件SHA256与署名'},
      {capability:'音效下载与播放',method:'GET / HEAD',path:'/audio/library/{id}/content',model:null,input:'可选download=1；支持Range',output:'原始音频文件；保留原格式与字节'},
      {capability:'音效浏览器试听',method:'GET / HEAD',path:'/audio/library/{id}/preview',model:null,input:'同一Bearer Key',output:'AIFF转WAV试听，其余保持原文件'},
      {capability:'音效授权署名',method:'GET',path:'/audio/library/{id}/credits',model:null,input:'GET /audio/library/credits可取全部清单，也可重复id参数选取最多100项',output:'原作者、来源、许可URL、是否需署名及署名文本'},
      {capability:'语音合成',method:'POST',path:'/audio/speech',model:'qwen3-tts-1.7b',input:'JSON：input、voice、language、可选 instruct、response_format=wav',output:'音频文件'},
      {capability:'语音识别',method:'POST',path:'/audio/transcriptions',model:'qwen3-asr-1.7b',input:'表单：file、model、language',output:'识别文本'},
      {capability:'图片识字',method:'POST',path:'/ocr',model:'apple-vision',input:'表单：file',output:'识别文本'},
      {capability:'文本向量',method:'POST',path:'/embeddings',model:'qwen3-embedding-0.6b',input:'JSON：input，最多 16 段',output:'向量'},
      {capability:'搜索重排',method:'POST',path:'/rerank',model:'qwen3-reranker-0.6b',input:'JSON：query、documents、top_n。最多 16 条、每条 4000 字、总计 32000 字',output:'按相关度排序，保留原 index'},
      {capability:'图片匹配',method:'POST',path:'/images/match',model:'siglip2-base',input:'表单：file、texts（JSON 数组，最多 16 个、每个 300 字）、可选 image2',output:'文字匹配分数或图片余弦相似度'},
      {capability:'图片抠图',method:'POST',path:'/images/remove-background',model:'birefnet-lite',input:'表单：file',output:'透明 PNG'},
      {capability:'语音区间',method:'POST',path:'/audio/vad',model:'silero-vad',input:'表单：file，可选 response_format=wav',output:'语音时间段 JSON 或拼接 WAV'},
      {capability:'语音降噪',method:'POST',path:'/audio/denoise',model:'rnnoise',input:'表单：file',output:'48kHz 单声道 WAV'},
      {capability:'声音相似度',method:'POST',path:'/audio/speakers/compare',model:'campplus-zh-en',input:'表单：file、file2。每段 1～60 秒',output:'声纹余弦相似度'},
      {capability:'意图分类',method:'POST',path:'/decisions',model:'startlux-decision-2b / gliner2.5-multi-decide / laya-multilingual',input:'JSON：input、model、可选 labels 与 threshold。文本最多 2000 字，labels 为 2～16 项',output:'choice、score、needs_review'},
      {capability:'声音档案',method:'GET / POST',path:'/studio/voices',model:null,input:'查询或保存声音；POST用multipart name/ref_audio/ref_text/language',output:'声音档案与id'},
      {capability:'工作室语音',method:'POST',path:'/studio/audio/speech',model:'vivic-qwen',input:'JSON input、voice=声音id/default、instructions；WAV等格式',output:'音频；OpenAI Base URL在原地址后加/studio'},
      {capability:'声音设计/克隆',method:'POST',path:'/studio/generate',model:'vivic-qwen',input:'multipart text、instruct或ref_audio/ref_text、language、stream=false',output:'WAV；X-Audio-Id与X-Audio-Path可下载已保存结果'},
      {capability:'模型列表',method:'GET',path:'/models',model:null,input:'无',output:'模型列表'},
      {capability:'音色列表',method:'GET',path:'/audio/voices',model:null,input:'无',output:'音色列表'},
      {capability:'文档拉取',method:'GET',path:'/docs',model:null,input:'无',output:'本文档的 JSON'},
      {capability:'文档下载',method:'GET',path:'/docs.md',model:null,input:'无',output:'Markdown 文件'},
    ],
  };
}
function docsMarkdown(spec){
 return documentationMarkdown(spec.guides?spec:buildDocumentation(spec));
}
async function serveDocs(req,res,route,url,publicDocument=false){
 res.setHeader('Access-Control-Allow-Origin','*');
 res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Vivic-Console');
 res.setHeader('Access-Control-Allow-Methods','GET, HEAD, OPTIONS');
 if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
 if(!['GET','HEAD'].includes(req.method))throw error(405,'Method not allowed');
 const documentKey=publicDocument?undefined:(admin(req)&&req.headers['x-vivic-console']==='1')?undefined:keyAuth(req);
 const spec=buildDocumentation(apiDocs(CONFIG.origin+PREFIX+'/v1'),{entry:documentKey,query:url.searchParams});
 const cache=publicDocument?'public, max-age=300':'no-store';
 if(route.endsWith('.md')){
  res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="ecstudio-api-usage.md"','Cache-Control':cache});
  return res.end(docsMarkdown(spec));
 }
 return json(res,200,spec,{'Cache-Control':cache});
}
// Included in the existing gateway by build_gateway.py; shares its authentication.
function recordKeyEvent(action,id){state.keyEvents??=[];state.keyEvents.push({at:stamp(),action,id});state.keyEvents=state.keyEvents.slice(-100);persist();}
async function mergedUsage(){
 const days=structuredClone(state.usage.days);
 try{
  const value=await workerJSON('/internal/file-usage');
  for(const [date,stats]of Object.entries(value.days)){
   const day=days[date]??={...counter(),models:{},keys:{}};
   for(const field of ['requests','success','errors','ms'])day[field]+=stats[field]||0;
   for(const kind of ['models','keys'])for(const [id,counts]of Object.entries(stats[kind]||{})){
    const group=day[kind][id]??=counter();for(const field of ['requests','success','errors','ms'])group[field]+=counts[field]||0;
   }
  }
 }catch{}
 return {since:state.usage.since,days,recent:state.recent.slice().reverse(),note:'模型推理及已结束的文件任务；耗时包含排队。上传、进度查询和下载不重复计为处理任务。历史Key次数保留。'};
}
const FILE_ROUTE=/^\/v1\/(?:capabilities|relation-predicates|files(?:\/[a-f0-9-]{36}(?:\/content)?)?|jobs(?:\/[a-f0-9-]{36}(?:\/cancel)?)?)$/;
async function fileProxy(req,res,route){
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, Idempotency-Key');
 res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');
 if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
 let key;
 if(admin(req)&&req.headers['x-vivic-console']==='1'){if(req.method!=='GET')sameOrigin(req);}
 else key=keyAuth(req);
 if(!['GET','POST','DELETE'].includes(req.method))throw error(405,'Method not allowed');
 const upload=route==='/v1/files'&&req.method==='POST';
 let payload,limiterFailure;
 if(req.method==='POST'){
  if(upload){
   if(!(req.headers['content-type']||'').startsWith('multipart/form-data;'))throw error(400,'上传请使用multipart/form-data');
   let bytes=0;const limiter=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>102*1024**2)limiterFailure=error(413,'上传超过100MB');callback(limiterFailure||null,chunk);}});
   req.once('error',exc=>limiter.destroy(exc));payload=req.pipe(limiter);
  }else payload=await body(req,32768);
 }
 if(key&&req.method!=='GET')keyRate(key);
 const controller=new AbortController();const cancel=()=>{if(!res.writableEnded)controller.abort();};res.once('close',cancel);
 try{
  const headers={'X-Vivic-Owner':key?.id||'console'};
  if(req.method==='POST')headers['Content-Type']=req.headers['content-type']||'application/json';
  if(req.headers['idempotency-key'])headers['Idempotency-Key']=req.headers['idempotency-key'];
  const response=await worker(route,{method:req.method,body:payload,headers,...(payload instanceof Readable?{duplex:'half'}:{}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(140000)])});
  if(key&&route==='/v1/jobs'&&req.method==='POST'&&response.ok){if(response.headers.get('x-vivic-job-created')==='true')key.requests++;key.lastUsed=stamp();persist();}
  const feedback={};for(const name of ['content-disposition','content-length'])if(response.headers.has(name))feedback[name]=response.headers.get(name);
  res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store',...feedback});
  if(response.body)await new Promise((resolve,reject)=>{const stream=Readable.fromWeb(response.body);stream.once('error',reject);res.once('finish',resolve);res.once('close',resolve);stream.pipe(res);});else res.end();
 }catch(exc){throw limiterFailure||exc;}finally{res.off('close',cancel);}
}

const STUDIO_UI='/voice-studio',STUDIO_API='/v1/studio';
function studioRoute(route){return route===STUDIO_UI||route.startsWith(STUDIO_UI+'/')||route===STUDIO_API||route.startsWith(STUDIO_API+'/');}
async function studioProxy(req,res,route,url){
 const web=route===STUDIO_UI||route.startsWith(STUDIO_UI+'/');let entry;
 if(web){
  if(!admin(req)){if(req.method==='GET'&&req.headers.accept?.includes('text/html')){res.writeHead(303,{Location:PREFIX+'/'});return res.end();}throw error(401,'请先登录API管理台');}
  if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==CONFIG.origin)throw error(403,'请从工作台执行操作');
 }else{
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, DELETE, OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  entry=keyAuth(req);if(req.method!=='GET')keyRate(entry);
 }
 if(route===STUDIO_UI){res.writeHead(308,{Location:PREFIX+STUDIO_UI+'/'});return res.end();}
 let native;
 if(web){native=route.slice(STUDIO_UI.length)||'/';if(native.startsWith('/api/'))native=native.slice(4);}
 else{
  native=route.slice(STUDIO_API.length)||'/';
  if(native.startsWith('/audio/speech')||native==='/audio/transcriptions')native='/v1'+native;
  else if(native==='/voices'||native.startsWith('/voices/'))native='/profiles'+native.slice('/voices'.length);
  else if(native==='/models')native='/v1/models';
  const allowed=(req.method==='GET'&&(/^\/(profiles(?:\/[a-f0-9]{8}(?:\/audio)?)?|engines|v1\/models|history|audio\/[a-f0-9]{8}\.(wav|mp3|ogg|opus))$/.test(native)))||
   (req.method==='POST'&&['/profiles','/generate','/v1/audio/speech','/v1/audio/transcriptions'].includes(native))||
   (['PUT','DELETE'].includes(req.method)&&/^\/profiles\/[a-f0-9]{8}$/.test(native));
  if(!allowed)throw error(404,'VoiceStudio接口未开放');
 }
 if(req.method==='POST'&&/^\/(models|engines)\/.*(install|download)/.test(native))throw error(409,'本服务的模型由管理员统一维护');
 const render=req.method==='POST'&&['/generate','/v1/audio/speech'].includes(native);const start=Date.now();let status=503,payload;
 if(['POST','PUT','PATCH'].includes(req.method)){
  let bytes=0;const limiter=new Transform({transform(chunk,enc,done){bytes+=chunk.length;done(bytes>22*1024**2?error(413,'上传超过22MB'):null,chunk);}});req.once('error',exc=>limiter.destroy(exc));payload=req.pipe(limiter);
 }
 const headers={'X-Vivic-Owner':entry?.id||'console'};
 for(const name of ['content-type','accept','range'])if(req.headers[name])headers[name]=req.headers[name];
 const controller=new AbortController();const cancel=()=>{if(!res.writableEnded)controller.abort();};res.once('close',cancel);
 try{
  const response=await worker('/internal/studio/proxy'+native+url.search,{method:req.method,headers,body:payload,...(payload?{duplex:'half'}:{}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(340000)])});status=response.status;
  const feedback={};for(const [name,value]of response.headers)if(['content-type','content-disposition','content-range','accept-ranges','x-omnivoice-backend','retry-after'].includes(name)||/^(x-audio-|x-gen-|x-seed|x-omnivoice-)/.test(name))feedback[name]=value;
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://edsionc.top https://api.github.com/repos/debpalash/VoiceStudio; img-src 'self' blob: data:; media-src 'self' blob: data:; font-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.writeHead(status,{'Cache-Control':'no-store',...feedback});
  if(response.body)await new Promise((resolve,reject)=>{const stream=Readable.fromWeb(response.body);stream.once('error',reject);res.once('finish',resolve);res.once('close',resolve);stream.pipe(res);});else res.end();
 }finally{res.off('close',cancel);if(render)addUsage('/v1/studio/audio/speech',status,Date.now()-start,entry,'vivic-qwen-studio');}
}

const ROUTES=new Set(['/v1/models','/v1/audio/voices',...Object.keys(MODEL_ROUTES)]);
const audioLibrary=createAudioLibrary({root:process.env.VIVIC_AUDIO_LIBRARY_ROOT||'/opt/vivic-game-audio',json,admin,keyAuth,keyRate,addUsage});
staticFiles['/audio-library.js']='audio-library.js';
staticFiles['/key-permissions.js']='key-permissions.js';
staticFiles['/docs/']='docs.html';
staticFiles['/docs/docs.js']='docs.js';
staticFiles['/docs/docs.css']='docs.css';
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
 try {
  const url=new URL(req.url,'http://localhost');
  if(url.pathname===PREFIX){res.writeHead(308,{Location:PREFIX+'/'});return res.end();}
  if(!url.pathname.startsWith(PREFIX+'/'))throw error(404,'Not found');
  const route=url.pathname.slice(PREFIX.length);
  if(studioRoute(route))return await studioProxy(req,res,route,url);
  if(route.startsWith('/console/'))return await consoleAPI(req,res,route.slice('/console'.length));
  if(route==='/health'&&req.method==='GET')return json(res,200,{ok:true,service:'vivic-model-api'});
  if(route==='/docs'){
   if(!['GET','HEAD'].includes(req.method))throw error(405,'Method not allowed');
   res.writeHead(308,{Location:PREFIX+'/docs/'+url.search});return res.end();
  }
  if(route==='/docs.json'||route==='/docs.md')return await serveDocs(req,res,route,url,true);
  if(route==='/v1/docs'||route==='/v1/docs.md')return await serveDocs(req,res,route,url);
  if(route==='/v1/permissions'){
   res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Authorization, X-Vivic-Console');res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
   if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
   const entry=admin(req)&&req.headers['x-vivic-console']==='1'?{permissions:['*']}:keyAuth(req);
   if(req.method!=='GET')throw error(405,'Method not allowed');
   return json(res,200,permissionInfo(entry));
  }
  if(audioLibrary.matches(route))return await audioLibrary.handle(req,res,route,url);
  if(FILE_ROUTE.test(route))return await fileProxy(req,res,route);
  if(ROUTES.has(route)) {
   res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
   res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
   if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
   let entry;
   if(admin(req)&&req.headers['x-vivic-console']==='1'){if(req.method!=='GET')sameOrigin(req);}
   else entry=keyAuth(req);
   if(!['GET','POST'].includes(req.method))throw error(405,'Method not allowed');
   const method=route==='/v1/models'||route==='/v1/audio/voices'?'GET':'POST';
   if(req.method!==method)throw error(405,'Method not allowed');
   const started=Date.now();const controller=new AbortController();let responseStatus=503,admitted=false,ticket,selectedModel=MODEL_ROUTES[route];
   const inference=Object.hasOwn(MODEL_ROUTES,route);
   const cancel=()=>{if(!res.writableEnded)controller.abort();};res.once('close',cancel);
   try {
    if(entry)keyRate(entry);
    if(inference){if(activeInference>=6)throw error(429,'任务队列已满，请稍后重试');activeInference++;admitted=true;ticket={ip:clientAddress(req),model:selectedModel};inferenceQueue.push(ticket);}
    let payload;
    if(method==='POST'){
     if((req.headers['content-type']||'').startsWith('application/json')){
      payload=await body(req,256*1024);
      if(route==='/v1/chat/completions'){let value;try{value=JSON.parse(payload);}catch{throw error(400,'JSON格式不正确');}if(value?.model!=='qwen3.8-27b-iq4-xs')throw error(400,'此接口仅支持 qwen3.8-27b-iq4-xs');}
      if(route==='/v1/decisions'){try{const value=JSON.parse(payload);if(['startlux-decision-2b','startlux-decision-4b','gliner2.5-multi-decide','laya-multilingual'].includes(value.model))selectedModel=value.model;}catch{}}
     if(ticket)ticket.model=selectedModel;
     }
     else{
      let bytes=0;const limiter=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>22*1024**2?error(413,'上传超过22MB'):null,chunk);}});
      req.once('error',error=>limiter.destroy(error));payload=req.pipe(limiter);
     }
    }
    const response=await worker(route,{method,body:payload,
     ...(payload instanceof Readable?{duplex:'half'}:{}),
     headers:method==='POST'?{'Content-Type':req.headers['content-type']||'application/json'}:{},
     signal:AbortSignal.any([controller.signal,AbortSignal.timeout(620000)])});
    responseStatus=response.status;
    if(route==='/v1/models'&&entry&&response.ok)return json(res,200,filterModels(await response.json(),entry));
    const feedback={};for(const name of ['x-model-cold','x-model-inference-ms'])if(response.headers.has(name))feedback[name]=response.headers.get(name);
    res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store',...feedback});
    if(response.body)await new Promise((resolve,reject)=>{
     const stream=Readable.fromWeb(response.body);stream.once('error',reject);res.once('finish',resolve);res.once('close',resolve);stream.pipe(res);
    });else res.end();
   }catch(exc){responseStatus=controller.signal.aborted?499:exc.status||503;throw exc;}
   finally{
    res.off('close',cancel);if(admitted){activeInference--;const index=inferenceQueue.indexOf(ticket);if(index>=0)inferenceQueue.splice(index,1);}
    if(inference)addUsage(route,controller.signal.aborted&&!res.writableFinished?499:responseStatus,Date.now()-started,entry,selectedModel);
   }
   return;
  }
  if(req.method==='GET'&&Object.hasOwn(staticFiles,route)) {
   const file=staticFiles[route];res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-cache'});
   return fs.createReadStream(path.join(DIR,'public',file)).pipe(res);
  }
  throw error(404,'接口不存在');
 }catch(exc){
  if(res.headersSent){res.destroy();return;}
  json(res,exc.status||503,{error:{message:exc.status?exc.message:'模型服务暂不可用，请稍后重试',type:'vivic_api_error'}});
 }
});
server.on('upgrade',(req,socket,head)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname!=='/api/voice-studio/api/ws/events'||!admin(req)||req.headers.origin!==CONFIG.origin){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;}
 const target=new URL(CONFIG.workerURL);const upstream=net.createConnection({host:target.hostname,port:Number(target.port)||80});
 upstream.once('connect',()=>{
  const headers=['GET /internal/studio/ws/ws/events HTTP/1.1','Host: '+target.host,'Connection: Upgrade','Upgrade: websocket','Authorization: Bearer '+CONFIG.workerToken,'X-Vivic-Owner: console'];
  for(const name of ['sec-websocket-key','sec-websocket-version','sec-websocket-extensions'])if(req.headers[name])headers.push(name+': '+req.headers[name]);
  upstream.write(headers.join('\r\n')+'\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);
 });
 upstream.once('error',()=>socket.destroy());socket.once('error',()=>upstream.destroy());socket.once('close',()=>upstream.destroy());
});

server.requestTimeout=200000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
if(process.argv.includes('--docs-self-check')){
  const spec=apiDocs('https://example.test/api/v1');
  const markdown=docsMarkdown(spec);
  if(!spec.endpoints.some(item=>item.path==='/docs'&&item.method==='GET'))throw Error('docs pull missing');
  if(!spec.endpoints.some(item=>item.path==='/docs.md'))throw Error('docs download missing');
  if(!markdown.includes('GET /v1/docs.md')||!markdown.includes('/audio/speech'))throw Error('docs markdown incomplete');
  console.log('docs-self-check ok');
  process.exit(0);
}
server.listen(CONFIG.port||8796,'127.0.0.1',()=>console.log('Vivic model gateway listening on loopback.'));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(()=>process.exit(0)));
setInterval(()=>{for(const [id,entry]of sessions)if(entry.expires<Date.now())sessions.delete(id);},60000).unref();
