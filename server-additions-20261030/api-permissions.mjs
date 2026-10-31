// A missing field preserves legacy full access. An explicit empty array grants no capabilities.
export const PERMISSIONS=[
 {id:'chat_qwen38',name:'Qwen3.8 27B 文本',description:'按需文本推理；不保存会话；与其他按需模型串行',models:['qwen3.8-27b-iq4-xs']},
 {id:'audio_library',name:'音效库',description:'搜索、试听、下载音效与 BGM，读取授权署名',models:[]},
 {id:'tts',name:'语音合成',description:'文字转语音与内置音色列表',models:['qwen3-tts-1.7b']},
 {id:'asr',name:'语音识别',description:'录音转文字',models:['qwen3-asr-1.7b']},
 {id:'ocr',name:'图片识字',description:'图片 OCR',models:['apple-vision']},
 {id:'embeddings',name:'文本向量',description:'文本 Embedding',models:['qwen3-embedding-0.6b']},
 {id:'rerank',name:'搜索重排',description:'文本相关度重排',models:['qwen3-reranker-0.6b']},
 {id:'image_match',name:'图片匹配',description:'图片与文本、图片与图片匹配',models:['siglip2-base']},
 {id:'background_remove',name:'图片抠图',description:'移除图片背景',models:['birefnet-lite']},
 {id:'vad',name:'语音区间',description:'语音活动检测',models:['silero-vad']},
 {id:'denoise',name:'语音降噪',description:'录音降噪',models:['rnnoise']},
 {id:'speaker_compare',name:'声音相似度',description:'声纹相似度比较',models:['campplus-zh-en']},
 {id:'decisions',name:'意图分类',description:'StartLux、GLiNER 与 Laya 分类',models:['startlux-decision-2b','startlux-decision-4b','gliner2.5-multi-decide','laya-multilingual']},
 {id:'files',name:'文件处理',description:'图片处理、OCR 打码、PDF、Office 转 PDF、音视频加工、关系识别；含文件和任务管理',models:['relateanything-vits16plus']},
 {id:'studio',name:'Voice Studio',description:'工作室 API、声音档案、声音设计与克隆',models:['vivic-qwen','vivic-qwen-studio','qwen3-voice-clone-1.7b','qwen3-voice-design-1.7b']},
];
const IDS=new Set(PERMISSIONS.map(x=>x.id));
const ROUTE_PERMISSIONS={
 '/v1/chat/completions':'chat_qwen38',
 '/v1/audio/speech':'tts','/v1/audio/voices':'tts','/v1/audio/transcriptions':'asr',
 '/v1/ocr':'ocr','/v1/embeddings':'embeddings','/v1/rerank':'rerank',
 '/v1/images/match':'image_match','/v1/images/remove-background':'background_remove',
 '/v1/audio/vad':'vad','/v1/audio/denoise':'denoise','/v1/audio/speakers/compare':'speaker_compare',
 '/v1/decisions':'decisions',
};
const failure=(status,message)=>Object.assign(Error(message),{status});
export function normalizePermissions(input){
 if(input===undefined)return ['*'];
 if(!Array.isArray(input)||input.length>PERMISSIONS.length||input.some(x=>typeof x!=='string'||(x!=='*'&&!IDS.has(x))))throw failure(400,'permissions 必须是有效权限 ID 数组');
 if(input.includes('*')){if(input.length!==1)throw failure(400,'全部权限不能与指定权限混用');return ['*'];}
 return PERMISSIONS.filter(x=>input.includes(x.id)).map(x=>x.id);
}
export function effectivePermissions(entry){
 if(!Object.hasOwn(entry,'permissions'))return ['*'];
 try{return normalizePermissions(entry.permissions===undefined?null:entry.permissions);}catch{return [];}
}
export function hasPermission(entry,id){const allowed=effectivePermissions(entry);return allowed.includes('*')||allowed.includes(id);}
export function requiredPermission(route){
 if(route==='/v1/audio/library'||route.startsWith('/v1/audio/library/'))return 'audio_library';
 if(route==='/v1/studio'||route.startsWith('/v1/studio/'))return 'studio';
 if(/^\/v1\/(?:capabilities|relation-predicates|files(?:\/|$)|jobs(?:\/|$))/.test(route))return 'files';
 return ROUTE_PERMISSIONS[route];
}
export function enforcePermission(entry,route){
 if(['/v1/docs','/v1/docs.md','/v1/models','/v1/permissions'].includes(route))return;
 const id=requiredPermission(route);
 // No implicit access for newly added routes: each capability must be registered.
 if(!id||!hasPermission(entry,id))throw failure(403,'此 Key 未获授权使用'+(id?'：'+PERMISSIONS.find(x=>x.id===id).name:'此接口'));
}
export function permissionInfo(entry){
 const permissions=effectivePermissions(entry);
 return {permissions,all:permissions.includes('*'),capabilities:PERMISSIONS.filter(x=>hasPermission(entry,x.id)).map(({models,...x})=>x)};
}
export function filterModels(value,entry){
 if(effectivePermissions(entry).includes('*'))return value;
 const ids=new Set(PERMISSIONS.filter(x=>hasPermission(entry,x.id)).flatMap(x=>x.models));
 return {...value,data:(value.data||[]).filter(model=>ids.has(model.id))};
}
