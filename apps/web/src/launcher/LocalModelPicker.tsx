import { useEffect, useState } from "react";
import "./local-model-picker.css";
interface Profile { id:string;label:string;gguf:{bytes:number}; }
/** Choice is a real managed-runtime operation; the source catalog never implies installation. */
export function LocalModelPicker({profileId,disabled,onChange}:{profileId:string;disabled:boolean;onChange(id:string):void}) {
  const [profiles,setProfiles]=useState<Profile[]>([]),[recommended,setRecommended]=useState<string|null>(null);
  useEffect(()=>{const controller=new AbortController();void fetch("/api/decision/models",{cache:"no-store",signal:controller.signal}).then(async r=>{if(!r.ok)return;const data=await r.json();if(controller.signal.aborted||!Array.isArray(data.profiles))return;setProfiles(data.profiles.filter((p:Profile)=>typeof p?.id==="string"&&typeof p.label==="string"&&typeof p.gguf?.bytes==="number"));setRecommended(data.recommendation?.profileId??null);}).catch(()=>{});return()=>controller.abort();},[]);
  if(!profiles.length)return null;
  return <label className="launcher-model-picker"><span>模型规格</span><select aria-label="决策模型" value={profileId} disabled={disabled} onChange={event=>onChange(event.target.value)}>{profiles.map(p=><option key={p.id} value={p.id}>{p.id.replace("startlux-","").toUpperCase()} · {(p.gguf.bytes/1e9).toFixed(2)} GB{p.id===recommended?" · 适合这台电脑":""}</option>)}</select></label>;
}
