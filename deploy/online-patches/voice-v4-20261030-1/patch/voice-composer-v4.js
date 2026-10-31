import { t as reactFactory } from './react-CQOZoUwg.js';
import { t as SiriOrb } from './siri-orb-DLFUd4qh.js';
const React=reactFactory(),el=React.createElement;

export function parseVivicWake(text){
 const normalized=String(text??'').normalize('NFKC').trim();
 const match=normalized.match(/^[\s,，。.!！?？]*(?:hi|嗨|嘿)[\s,，、。.!！:：-]*(?:vivic|vivi[kc]|维维克|薇薇克|微微克|维维可)(?=$|[\s,，。.!！?？:：、\u3400-\u9fff])[\s,，。.!！?？:：、-]*/iu);
 return match?{detected:true,command:normalized.slice(match[0].length).trim()}:{detected:false,command:''};
}

export function useVivicVoiceV4({busy,disabled,reply,colors,reducedMotion,hasDraft}){
 const [mode,setMode]=React.useState('voice');
 const [phase,setPhase]=React.useState('idle');
 const [status,setStatus]=React.useState({active:false,error:''});
 const control=React.useRef(null),replyTimer=React.useRef(null);
 const onControl=React.useCallback(fn=>{control.current=fn;},[]);
 const onPhase=React.useCallback(value=>{if(value!=='replying')clearTimeout(replyTimer.current);setPhase(value);},[]);
 const onStatus=React.useCallback(value=>setStatus(value),[]);
 React.useEffect(()=>{clearTimeout(replyTimer.current);if(!busy&&reply){setPhase('replying');replyTimer.current=setTimeout(()=>setPhase('idle'),1800);}return()=>clearTimeout(replyTimer.current);},[busy,reply]);
 const changeMode=React.useCallback(next=>{clearTimeout(replyTimer.current);setMode(next);setPhase('idle');if(next==='text')requestAnimationFrame(()=>{setTimeout(()=>document.querySelector('.vivic-composer[data-vivic-input-mode="text"] [data-vivic-command-input]')?.focus({preventScroll:true}),reducedMotion?0:540);});},[reducedMotion]);
 return{mode,phase:busy?'thinking':phase,status,colors,reducedMotion,hasDraft,disabled,
  toText:()=>changeMode('text'),toVoice:()=>changeMode('voice'),onControl,onPhase,onStatus,
  interact:()=>{clearTimeout(replyTimer.current);setPhase('idle');control.current?.();}};
}

const mic=el('svg',{width:18,height:18,viewBox:'0 0 16 16',fill:'currentColor','aria-hidden':true},el('path',{fillRule:'evenodd',d:'M2,8 Q2,10.485 3.757,12.243 Q5.515,14 8,14 Q10.485,14 12.243,12.243 Q14,10.485 14,8 L16,8 Q16,11.314 13.657,13.657 Q11.314,16 8,16 Q4.686,16 2.343,13.657 Q0,11.314 0,8 Z M11.5,3.5 L11.5,7.5 Q11.5,11 8,11 Q6.55,11 5.525,9.975 Q4.5,8.95 4.5,7.5 L4.5,3.5 Q4.5,0 8,0 Q11.5,0 11.5,3.5 Z M9.5,3.5 Q9.5,2 8,2 Q6.5,2 6.5,3.5 L6.5,7.5 Q6.5,8.121 6.939,8.561 Q7.379,9 8,9 Q9.5,9 9.5,7.5 Z'}));
export function VivicTextVoiceToggle({onClick,disabled}){return el('button',{type:'button',className:'vivic-composer-icon vv4-text-voice',onClick,disabled,'aria-label':'切换为语音输入',title:'切换为语音输入'},mic);}

export function VivicComposerSurface({voice,children}){
 const voiceMode=voice.mode==='voice',active=['listening','recording'].includes(voice.phase);
 let hint='说“Hi，Vivic”唤醒';
 if(voice.status.error)hint=voice.status.error+' · 点击小球重试，或用键盘输入';
 else if(!voice.status.active)hint='点击小球开启麦克风，再说“Hi，Vivic”';
 return el('div',{className:'vv4-surface','data-mode':voice.mode,'data-phase':voice.phase,'data-has-draft':voice.hasDraft||undefined},
  el('div',{className:'vv4-original',inert:voiceMode||undefined,'aria-hidden':voiceMode||undefined},children),
  el('div',{className:'vv4-glow','aria-hidden':true}),
  el('div',{className:'vv4-stage','aria-hidden':!voiceMode||undefined},
   el('button',{type:'button',className:'vv4-orb',disabled:voice.disabled,tabIndex:voiceMode?0:-1,onClick:voice.interact,'aria-label':active?'取消本次语音':'启用语音唤醒',title:active?'取消本次语音':hint},
    el('span',{className:'vv4-halo','aria-hidden':true}),
    el('span',{className:'vv4-orb-inner','aria-hidden':true},el('span',{className:'vv4-soft'}),el('span',{className:'vv4-soft second'}),el(SiriOrb,{size:'72px',colors:voice.colors,reducedMotion:voice.reducedMotion,state:active?'listening':voice.phase==='thinking'||voice.phase==='transcribing'?'thinking':voice.phase==='replying'?'streaming':'idle',animationDuration:22}))),
   el('button',{type:'button',className:'vv4-keyboard',tabIndex:voiceMode?0:-1,onClick:voice.toText,'aria-label':'切换为文字输入',title:'文字输入'},el('svg',{width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.4,strokeLinecap:'round','aria-hidden':true},el('rect',{x:3,y:5,width:18,height:14,rx:3}),el('path',{d:'M7 9h.01M11 9h.01M15 9h.01M18 9h.01M7 12h.01M11 12h.01M15 12h.01M18 12h.01M8 16h8'}))),
   el('p',{className:'vv4-wake-hint',role:voice.status.error?'status':undefined,'data-error':!!voice.status.error},hint),
   voice.hasDraft&&el('small',{className:'vv4-draft-note'},'文字草稿已保留')));
}

// Retains the site's PCM recorder, WAV encoder and transcription API. No simulated speech or actions.
export function VivicWakeListener(props){
 const current=React.useRef(props);current.current=props;
 const [enabled,setEnabled]=React.useState(true),[restart,setRestart]=React.useState(0);
 const [focused,setFocused]=React.useState(()=>!document.hidden&&document.hasFocus());
 const armed=React.useRef(0),expiry=React.useRef(null);
 const resetArm=()=>{armed.current=0;clearTimeout(expiry.current);current.current.onPhase?.('idle');};
 React.useEffect(()=>{const focus=()=>setFocused(!document.hidden&&document.hasFocus());window.addEventListener('focus',focus);window.addEventListener('blur',focus);document.addEventListener('visibilitychange',focus);return()=>{window.removeEventListener('focus',focus);window.removeEventListener('blur',focus);document.removeEventListener('visibilitychange',focus);clearTimeout(expiry.current);};},[]);
 React.useEffect(()=>{current.current.onControl?.(()=>{resetArm();setEnabled(true);setRestart(n=>n+1);});return()=>current.current.onControl?.(null);},[]);
 React.useEffect(()=>{
  if(!enabled||!focused||props.disabled||props.speaking){resetArm();current.current.onStatus?.({active:false,error:''});return;}
  const controller=new AbortController,recorder=new props.Recorder();
  let chunks=[],frames=0,quiet=0,spoken=false,finishing=false,restartTimer=null;
  const fail=error=>{if(controller.signal.aborted)return;resetArm();current.current.onStatus?.({active:false,error:error instanceof Error?error.message:'麦克风暂不可用'});};
  const listenAgain=()=>{if(!controller.signal.aborted)restartTimer=setTimeout(()=>setRestart(n=>n+1),250);};
  const consume=async()=>{
   if(finishing)return;finishing=true;recorder.stop();
   const wasArmed=armed.current>Date.now();
   if(wasArmed)current.current.onPhase?.('transcribing');
   const all=chunks;chunks=[];const wav=props.encodeWav(all,16000),samples=new Float32Array(frames);let offset=0;for(const chunk of all){samples.set(chunk,offset);offset+=chunk.length;}
   try{
    const text=await current.current.onSegment?.({type:'segment',samples,sampleRate:16000,wav,signal:controller.signal});
    if(controller.signal.aborted)return;
    const parsed=parseVivicWake(text);
    if(parsed.detected){
     armed.current=Date.now()+20000;clearTimeout(expiry.current);expiry.current=setTimeout(resetArm,20000);current.current.onPhase?.('listening');
     if(parsed.command){current.current.onBegin?.();resetArm();current.current.onPhase?.('thinking');current.current.onTranscript?.(parsed.command);}
    }else if(wasArmed&&armed.current>Date.now()&&typeof text==='string'&&text.trim()){
     current.current.onBegin?.();resetArm();current.current.onPhase?.('thinking');current.current.onTranscript?.(text.trim());
    }else if(armed.current>Date.now())current.current.onPhase?.('listening');
    listenAgain();
   }catch(error){if(!controller.signal.aborted){fail(error);listenAgain();}}
  };
  props.onPhase?.(armed.current>Date.now()?'listening':'idle');
  recorder.start({signal:controller.signal,maxSeconds:300,onError:fail,onPcm:pcm=>{
   if(finishing||controller.signal.aborted)return;
   let power=0;for(const x of pcm)power+=x*x;const speech=Math.sqrt(power/pcm.length)>.016;
   if(!spoken&&!speech)return;
   if(speech){spoken=true;quiet=0;if(armed.current>Date.now())current.current.onPhase?.('recording');}else quiet+=pcm.length;
   chunks.push(pcm.slice());frames+=pcm.length;
   if(frames>=224000||spoken&&quiet>=13600&&frames>=6400)void consume();
  }}).then(()=>{if(!controller.signal.aborted)current.current.onStatus?.({active:true,error:''});}).catch(fail);
  return()=>{controller.abort();clearTimeout(restartTimer);recorder.dispose();};
 },[enabled,focused,props.disabled,props.speaking,props.ownerKey,props.cancelKey,restart]);
 return el('div',{className:'vivic-wake vv4-wake-controller','data-vivic-local-wake':true},el('button',{type:'button',onClick:()=>setEnabled(value=>!value),'aria-label':enabled?'关闭监听':'开启监听','aria-pressed':enabled},'语音监听'));
}
