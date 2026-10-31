(() => {
  'use strict';
  if(window.__vivicStartup)return;
  const base=new URL('.',document.currentScript.src),build='direct-entry-20261028-1',reports=new Set();
  const backgroundKey='vivic.visual-background.v1';
  let appearance={theme:'light',palette:'milk',colors:['#f3f7fb','#d0e4fd','#d6f3f2','#5a8cc8'],effect:'glow',speed:1,intensity:.28,motionMode:'subtle',animationOffset:0};
  try{
    const cached=JSON.parse(localStorage.getItem(backgroundKey)||'null');
    if(cached&&['light','dark'].includes(cached.theme)&&Array.isArray(cached.colors)&&cached.colors.length===4&&cached.colors.every(color=>/^#[0-9a-f]{6}$/i.test(color))&&['glow','aurora','silk','liquid','none'].includes(cached.effect)){
      appearance={...appearance,...cached,speed:Math.max(.25,Math.min(2,Number(cached.speed)||1)),intensity:Math.max(0,Math.min(1,Number(cached.intensity)||0)),animationOffset:Math.max(0,Math.min(160000,Number(cached.animationOffset)||0))};
    }
  }catch{}
  window.__vivicInitialBackground=appearance;
  const rootStyle=document.documentElement.style;
  rootStyle.colorScheme=appearance.theme;
  for(const [key,value]of Object.entries({'--vivic-initial-base':appearance.colors[0],'--atelier-base':appearance.colors[0],'--atelier-glow-1':appearance.colors[1],'--atelier-glow-2':appearance.colors[2],'--atelier-accent':appearance.colors[3],
    '--atelier-strength':String(appearance.intensity),'--atelier-duration':String(({glow:15,aurora:12,silk:20,liquid:15,none:15})[appearance.effect]/appearance.speed)+'s',
    '--atelier-travel':appearance.motionMode==='vivid'?'7%':'4%','--atelier-scale':appearance.motionMode==='vivid'?'1.18':'1.1','--vivic-background-offset':String(-appearance.animationOffset)+'ms'}))rootStyle.setProperty(key,value);
  const backgroundSeed=()=>'<div id="vivic-background-seed" class="vivic-theme-atmosphere vivic-shared-background" aria-hidden="true" data-space-effect="'+appearance.effect+'" data-space-running="false"><div class="atelier-glow-layer"></div></div>';

  const css=new URL('app-shell.css',base).href;
  if(![...document.querySelectorAll('link[rel=stylesheet]')].some(link=>link.href===css)){const link=document.createElement('link');link.rel='stylesheet';link.href=css;document.head.appendChild(link);}
  document.getElementById('vivic-startup')?.remove();
  function shell(){const root=document.getElementById('root');if(root&&!root[Symbol.for('vivic.react.root')])root.innerHTML=backgroundSeed();}
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
