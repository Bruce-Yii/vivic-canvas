(() => {
  'use strict';
  if(window.__vivicStartup)return;
  const base=new URL('.',document.currentScript.src),build='direct-entry-20261028-1',shells={"home":"<div class=\"vs-app\" aria-busy=\"true\" data-vivic-app-shell><div class=\"vs-ui\" inert><header class=\"vs-header\"><div><button disabled aria-label=\"设置\">⚙</button><button disabled aria-label=\"历史\">◷</button><button disabled aria-label=\"帮助\">?</button></div><div><button disabled>▦ Space</button><button disabled aria-label=\"展示页\">▱</button></div></header><footer class=\"vs-composer\"><input disabled placeholder=\"给 Vivic 发消息\" aria-label=\"给 Vivic 发消息\"><span>＋</span><span>♩</span></footer></div></div>","settings":"<div class=\"vs-app\" aria-busy=\"true\" data-vivic-app-shell><section class=\"vs-settings\" inert><header><span>设置</span><button disabled aria-label=\"关闭设置\">×</button></header><nav><span class=\"vs-selected\">连接</span><span>设备</span><span>偏好</span><span>语音</span><span>数据</span></nav><div class=\"vs-settings-body\"><p>StepFun</p><div class=\"vs-input-row\"><input disabled placeholder=\"输入 StepFun API Key\"><button disabled>连接</button></div><hr><p>本地 API 平台</p><div class=\"vs-input-row\"><input disabled placeholder=\"输入本地 API 平台 Key\"><button disabled>连接</button></div><hr><p class=\"vs-muted\">应用与生活服务</p></div></section></div>"},reports=new Set();
  const css=new URL('app-shell.css',base).href;
  if(![...document.querySelectorAll('link[rel=stylesheet]')].some(link=>link.href===css)){const link=document.createElement('link');link.rel='stylesheet';link.href=css;document.head.appendChild(link);}
  document.getElementById('vivic-startup')?.remove();
  function shell(){const root=document.getElementById('root');if(root&&!root[Symbol.for('vivic.react.root')])root.innerHTML=shells[location.pathname==='/control'?'settings':'home'];}
  function report(kind,error){
    if(reports.has(kind)||reports.size>=5)return;reports.add(kind);
    const raw=String(error?.message||error||''),known=raw.match(/^(?:Cannot (?:access|read|set)[^\n]{0,160}|[^\n]{0,60} is not (?:defined|a function)|Minified React error #\d+|Failed to fetch dynamically imported module|Unable to preload CSS|Invalid (?:session|authenticated session) response)/);
    const message=(known?.[0]||error?.name||'StartupError').replace(/https?:\/\/\S+/g,'[resource]').replace(/[A-Za-z0-9_-]{32,}/g,'[id]').slice(0,180),frame=String(error?.stack||'').match(/\/([^/\s?:]+\.js):(\d+):(\d+)/);
    fetch('/__vivic/boot-error?'+new URLSearchParams({build,kind,message,source:frame?frame.slice(1).join(':'):''}),{method:'POST',credentials:'omit',keepalive:true}).catch(()=>{});
    console.error('[Vivic startup]',kind,error);
  }
  function fail(kind,error){
    report(kind,error);shell();
    if(!document.getElementById('vivic-network-status')){
      const notice=document.createElement('div');notice.id='vivic-network-status';notice.className='vivic-inline-notice';notice.setAttribute('role','alert');
      const text=document.createElement('span');text.textContent='网络连接暂时中断';const retry=document.createElement('button');retry.type='button';retry.textContent='重试';retry.onclick=()=>location.reload();notice.append(text,retry);document.body.appendChild(notice);
    }
  }
  const api={report,fail,build,sessionSnapshot:null,firstSession:null};window.__vivicStartup=api;
  // Start the authenticated check in parallel with the application download; never cache a user or bypass the server.
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  api.firstSession=fetch('/api/space/session',{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(async response=>{
    if(!response.ok)throw new Error('SessionRequestFailed');const session=await response.json();if(typeof session?.authenticated!=='boolean'||session.authenticated&&!session.user?.id)throw new Error('Invalid session response');api.sessionSnapshot=session;return session;
  }).finally(()=>clearTimeout(timer));api.firstSession.catch(()=>{});
  window.addEventListener('error',event=>{if(event.error)report('script',event.error);else if(event.target?.tagName==='SCRIPT')fail('script-load',new Error('ScriptLoadError'));},true);
  window.addEventListener('unhandledrejection',event=>{report('promise',event.reason);if(!document.getElementById('root')?.textContent.trim())fail('startup',event.reason);});
  async function start(){
    shell();
    try{const app=await import(new URL('app-runtime.js',base).href);app.mountVivicApp(document.getElementById('root'));}
    catch(error){report('module',error);let last=Date.now();try{last=Number(sessionStorage.getItem('vivic.startup.retry')||0);sessionStorage.setItem('vivic.startup.retry',String(Date.now()));}catch{}if(navigator.onLine&&Date.now()-last>60000){location.reload();return;}fail('module-load',error);}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else void start();
})();
