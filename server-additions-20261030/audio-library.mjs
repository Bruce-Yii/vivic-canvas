import fs from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';

const ROOT_ROUTE='/v1/audio/library';
const TYPES={ogg:'audio/ogg',wav:'audio/wav',mp3:'audio/mpeg',flac:'audio/flac',aif:'audio/aiff',aiff:'audio/aiff',m4a:'audio/mp4',opus:'audio/ogg'};
const ALIASES={音效:'sfx',背景音乐:'bgm',音乐:'music',短音乐:'jingle',环境声:'ambience',点击:'click',按钮:'click',金币:'coin',硬币:'coin',胜利:'win',失败:'lose',跳跃:'jump',脚步:'footsteps',魔法:'magic',科幻:'scifi',太空:'space',休闲:'casual',可爱:'cute',温馨:'cozy',农场:'farm',烹饪:'cooking',经营:'management',自然:'nature',水:'water',雨:'rain',开门:'door',复古:'retro',街机:'arcade',冒险:'adventure',谜题:'puzzle',纸:'paper',木:'wood',玻璃:'glass',怪物:'creature',射击:'shoot',命中:'hit',海滩:'beach',派对:'party',解锁:'unlock',消除:'match',爆炸:'explosion'};
const fail=(status,message)=>Object.assign(Error(message),{status});
function number(params,name,fallback,min,max,integer=false){
 if(!params.has(name))return fallback;
 const raw=params.get(name),value=Number(raw);
 if(!raw.trim()||!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value)))throw fail(400,`${name} 参数无效`);
 return value;
}
export function createAudioLibrary({root,json,admin,keyAuth,keyRate,addUsage}){
 let catalog,assets,byId,stats;
 function load(){
  if(catalog)return;
  const value=JSON.parse(fs.readFileSync(path.join(root,'catalog.json'),'utf8'));
  const map=new Map();
  for(const a of value.assets){
   if(!/^[a-f0-9]{24}$/.test(a.id)||map.has(a.id))throw Error('Invalid audio catalog ID');
   const target=path.resolve(root,a.path);
   if(!target.startsWith(path.resolve(root)+path.sep)||!a.path.startsWith('raw/'))throw Error('Invalid audio catalog path');
   map.set(a.id,a);
  }
  assets=value.assets;byId=map;
  const counts=field=>Object.fromEntries(Object.entries(assets.reduce((out,a)=>{for(const v of Array.isArray(a[field])?a[field]:[a[field]])out[v]=(out[v]||0)+1;return out;},{})).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])));
  stats={object:'audio.library',total:assets.length,content_id:value.content_id,kinds:counts('kind'),sources:counts('source'),licenses:counts('license'),tags:counts('tags'),themes:counts('themes'),formats:counts('format'),total_bytes:assets.reduce((n,a)=>n+a.size,0),quality_note:'质量分数与标签来自原素材库，不代表本次重新试听评级。'};
  catalog=value;
 }
 const exposed=a=>({...a,content_url:`/api${ROOT_ROUTE}/${a.id}/content`,preview_url:`/api${ROOT_ROUTE}/${a.id}/${['aif','aiff'].includes(a.format)?'preview':'content'}`,credits_url:`/api${ROOT_ROUTE}/${a.id}/credits`});
 async function content(req,res,a,preview,url){
  const relative=preview?`previews/${a.id}.wav`:a.path;
  const target=fs.realpathSync(path.join(root,relative));
  if(!target.startsWith(fs.realpathSync(root)+path.sep))throw fail(404,'音频不存在');
  const stat=fs.statSync(target),size=stat.size;
  const format=preview?'wav':a.format,etag=`"${a.sha256}${preview?'-preview':''}"`;
  const name=path.basename(a.path,path.extname(a.path))+'.'+format;
  const headers={'Content-Type':TYPES[format]||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'private, no-cache',ETag:etag,'Content-Disposition':`${url.searchParams.get('download')==='1'?'attachment':'inline'}; filename="${a.id}.${format}"; filename*=UTF-8''${encodeURIComponent(name)}`};
  if(req.headers['if-none-match']===etag){res.writeHead(304,headers);return res.end();}
  let start=0,end=size-1,status=200;
  if(req.headers.range&&(!req.headers['if-range']||req.headers['if-range']===etag)){
   const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
   let valid=!!match&&(match[1]!==''||match[2]!=='');
   if(valid){
    if(!match[1]){const suffix=Number(match[2]);valid=Number.isSafeInteger(suffix)&&suffix>0;start=Math.max(0,size-suffix);}
    else{start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1;}
    valid=valid&&Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start<size&&start>=0&&end>=start;
   }
   if(!valid){res.writeHead(416,{...headers,'Content-Range':`bytes */${size}`});return res.end();}
   status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  }
  res.writeHead(status,{...headers,'Content-Length':end-start+1});
  if(req.method==='HEAD')return res.end();
  await pipeline(fs.createReadStream(target,{start,end}),res);
 }
 return {
  matches:route=>route===ROOT_ROUTE||route.startsWith(ROOT_ROUTE+'/'),
  async handle(req,res,route,url){
   res.setHeader('Access-Control-Allow-Origin','*');
   res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, Range, If-Range, If-None-Match, X-Vivic-Console');
   res.setHeader('Access-Control-Allow-Methods','GET, HEAD, OPTIONS');
   res.setHeader('Access-Control-Expose-Headers','Content-Disposition, Content-Length, Content-Range, Accept-Ranges, ETag');
   if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
   const key=admin(req)?undefined:keyAuth(req);
   if(!['GET','HEAD'].includes(req.method))throw fail(405,'Method not allowed');
   if(key)keyRate(key);
   load();
   if(route===ROOT_ROUTE+'/stats')return json(res,200,stats);
   if(route===ROOT_ROUTE){
    const p=url.searchParams,q=(p.get('q')||'').trim().toLowerCase();
    if(q.length>200)throw fail(400,'搜索词最多200字');
    const limit=number(p,'limit',24,1,100,true),offset=number(p,'offset',0,0,1000000,true);
    const minDuration=number(p,'min_duration',0,0,86400),maxDuration=number(p,'max_duration',86400,0,86400),minQuality=number(p,'min_quality',0,0,100);
    if(minDuration>maxDuration)throw fail(400,'最小时长不能大于最大时长');
    const filterNames={kind:Object.keys(stats.kinds),source:Object.keys(stats.sources),license:Object.keys(stats.licenses),format:Object.keys(stats.formats)};
    for(const [name,allowed]of Object.entries(filterNames))if(p.has(name)&&!allowed.includes(p.get(name)))throw fail(400,`${name} 参数无效`);
    const sort=p.get('sort')||'name';if(!['name','duration','-duration','quality'].includes(sort))throw fail(400,'sort 参数无效');
    const terms=q.split(/\s+/).filter(Boolean).map(t=>ALIASES[t]||t);
    let matches=assets.filter(a=>{
     for(const field of ['kind','source','license','format'])if(p.has(field)&&a[field]!==p.get(field))return false;
     for(const field of ['tag','theme'])if(p.has(field)&&!a[field==='tag'?'tags':'themes'].includes(p.get(field)))return false;
     if(a.duration<minDuration||a.duration>maxDuration||a.quality<minQuality)return false;
     const haystack=[a.name,a.kind,a.source,a.pack,a.author,...a.tags,...a.themes].join(' ').toLowerCase();
     return terms.every(t=>haystack.includes(t));
    });
    matches.sort((a,b)=>(sort==='duration'?a.duration-b.duration:sort==='-duration'?b.duration-a.duration:sort==='quality'?b.quality-a.quality:0)||a.name.localeCompare(b.name,'en',{numeric:true})||a.id.localeCompare(b.id));
    return json(res,200,{object:'list',total:matches.length,limit,offset,has_more:offset+limit<matches.length,data:matches.slice(offset,offset+limit).map(exposed)});
   }
   if(route===ROOT_ROUTE+'/credits'){
    const ids=url.searchParams.getAll('id');
    if(ids.length>100)throw fail(400,'一次最多100个素材ID');
    const selected=ids.length?ids.map(id=>{const a=byId.get(id);if(!a)throw fail(404,'音频不存在');return a;}):assets;
    return json(res,200,{object:'audio.credits',total:selected.length,data:selected.map(a=>({id:a.id,name:a.name,author:a.author,license:a.license,license_url:a.license_url,source_url:a.source_url,attribution_required:a.attribution_required,attribution:a.attribution}))});
   }
   const match=new RegExp('^'+ROOT_ROUTE+'/([a-f0-9]{24})(?:/(content|preview|credits))?$').exec(route);
   if(!match||!byId.has(match[1]))throw fail(404,'音频不存在');
   const a=byId.get(match[1]);
   if(!match[2])return json(res,200,exposed(a));
   if(match[2]==='credits')return json(res,200,{id:a.id,name:a.name,author:a.author,license:a.license,license_url:a.license_url,source_url:a.source_url,attribution_required:a.attribution_required,attribution:a.attribution});
   const preview=match[2]==='preview'&&['aif','aiff'].includes(a.format);
   const started=Date.now();
   res.once('finish',()=>{if(req.method==='GET'&&res.statusCode===200)addUsage(ROOT_ROUTE,res.statusCode,Date.now()-started,key,'game-audio-library');});
   try{await content(req,res,a,preview,url);}catch(exc){if(exc.code==='ENOENT')throw fail(404,'音频不存在');throw exc;}
  }
 };
}
