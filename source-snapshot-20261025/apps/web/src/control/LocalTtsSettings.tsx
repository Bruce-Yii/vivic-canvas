import { useEffect, useRef, useState } from "react";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { Button } from "@/components/ui/button";
import { cancelSpeech } from "@/ai/speech";
import { ConfirmDialog } from "./ConfirmDialog";
interface Status { phase:string;enabled:boolean;voice:string;downloadedBytes:number;totalBytes:number;error:string|null; }
const labels:Record<string,string>={absent:"尚未准备",downloading:"正在下载",installing:"正在准备运行环境",cached:"已准备",loading:"正在加载",ready:"已就绪",stopping:"正在释放内存",error:"需要重试"};
export function LocalTtsSettings({disabled=false,onPreview}:{disabled?:boolean;onPreview?:()=>void}) {
  const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const revision=useRef(0),active=useRef(false),mutating=useRef(false);
  useEffect(()=>{active.current=true;const refresh=async()=>{const epoch=revision.current;if(mutating.current)return;try{const r=await fetch("/api/local-tts/status",{cache:"no-store",signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error();const next=await r.json();if(active.current&&epoch===revision.current){setStatus(next);setError(null);}}catch{if(active.current&&epoch===revision.current)setError("本地语音状态未连接。");}};void refresh();const t=setInterval(()=>void refresh(),2000);return()=>{active.current=false;++revision.current;clearInterval(t);};},[]);
  const action=async(name:"prepare"|"enable"|"stop"|"clear")=>{if(mutating.current)return;mutating.current=true;++revision.current;setBusy(true);setError(null);if(name==="stop"||name==="clear")cancelSpeech();try{const r=await fetch(`/api/local-tts/${name}`,{method:"POST",signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error();const next=await r.json();if(active.current)setStatus(next);}catch{if(active.current)setError("操作结果待确认，连接恢复后会更新。");}finally{mutating.current=false;if(active.current)setBusy(false);}};
  const pending=Boolean(status&&["downloading","installing","loading","stopping"].includes(status.phase)),locked=disabled||busy||!status||Boolean(error);
  return <section className="se-preference-block" data-vivic-local-tts>
    <div className="se-row"><span>本地语音回复</span><span className="se-caption" role="status">{error??(status?labels[status.phase]??status.phase:"正在连接")}</span></div>
    <p className="se-caption">中文女声 · 首次音色约 400 MB，运行环境另行准备。</p>
    {pending&&status?.phase==="downloading"&&<progress aria-label="本地音色下载进度" className="w-full" max={status.totalBytes} value={status.downloadedBytes}/>}
    <div className="flex flex-wrap gap-2 mt-2">
      <Button className="launcher-secondary" size="sm" variant="secondary" disabled={locked||pending||status?.enabled} onClick={()=>void action("prepare")}><HarkIcon name="download" size={14}/>准备音色</Button>
      <Button className="launcher-secondary" size="sm" variant="secondary" disabled={locked||pending||status?.enabled||status?.phase==="absent"} onClick={()=>void action("enable")}>启动语音</Button>
      <Button className="launcher-secondary" size="sm" variant="outline" disabled={locked||status?.phase==="stopping"||!pending&&!status?.enabled} onClick={()=>void action("stop")}>{pending&&status?.phase!=="loading"&&status?.phase!=="stopping"?"取消准备":"停止语音"}</Button>
      {onPreview&&<Button className="launcher-text-button" size="sm" variant="ghost" disabled={locked||status?.phase!=="ready"} onClick={onPreview}><HarkIcon name="play" size={14}/>试听</Button>}
      <ConfirmDialog title="清理本地音色？" description="停止语音并删除音色文件，下次使用需要重新准备。" confirmLabel="清理音色" onConfirm={()=>void action("clear")} disabled={locked||pending} trigger={<Button className="launcher-text-button" size="sm" variant="ghost" disabled={locked||pending}>清理</Button>}/>
    </div>
    {(error||status?.error)&&<p className="se-error" role="status">{error||status?.error}</p>}
  </section>;
}
