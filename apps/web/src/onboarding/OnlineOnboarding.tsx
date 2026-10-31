import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { FileText, KeyRound, LayoutGrid, MessageCircle, ShieldCheck } from "lucide-react";
import { HarkBackdrop, HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOnlineConnection } from "./useOnlineConnection";
import "./online-onboarding.css";

export interface OnlineOnboardingProps {
  onComplete(draft?: string): void;
  onCancel?(): void;
  disabled?: boolean;
  theme?: "light" | "dark";
}

const titles = ["Vivic 是什么", "配置 API Key", "开始使用"] as const;
export const ONLINE_STARTER_DRAFT = "创建一个便笺，内容是：今天完成一件要事，留出休息时间。";

/** Online-only onboarding; visibility and completion persistence belong to its
 * owner. This component never sends an intent or changes real canvas content. */
export function OnlineOnboarding({ onComplete, onCancel, disabled = false, theme }: OnlineOnboardingProps) {
  const [step, setStep] = useState(0);
  const [showExample, setShowExample] = useState(false);
  const [basic, setBasic] = useState(false);
  const [includeDraft, setIncludeDraft] = useState(false);
  const [finished, setFinished] = useState(false);
  const done = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const initialFocus = useRef(true);
  const inputId = useId();
  const online = useOnlineConnection(step === 1 && !disabled && !finished);
  const busy = online.connection.phase === "checking" || online.connection.phase === "connecting";
  const connected = online.connection.phase === "connected";
  const blocked = disabled || finished;

  useEffect(() => {
    if (initialFocus.current) { initialFocus.current = false; return; }
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  const move = (next: number) => {
    if (blocked) return;
    online.invalidate();
    setStep(next);
  };
  const cancel = () => {
    if (blocked || done.current) return;
    done.current = true;
    online.invalidate();
    setFinished(true);
    onCancel?.();
  };
  const complete = () => {
    if (blocked || done.current) return;
    done.current = true;
    online.invalidate();
    setFinished(true);
    onComplete(!basic && includeDraft ? ONLINE_STARTER_DRAFT : undefined);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); if (!blocked) void online.connect(); };

  return <main className="vo-onboarding vh-hark" data-appearance={theme} data-vivic-online-onboarding data-step={step + 1}>
    <HarkBackdrop theme={theme} />
    <div className="vo-shell">
      <header className="vo-topbar">
        <span>Vivic</span>
        {onCancel && <Button variant="ghost" size="icon" aria-label="关闭新手引导" disabled={blocked} onClick={cancel}><HarkIcon name="close" size={20} /></Button>}
      </header>
      <section className="vo-content" aria-labelledby={`${inputId}-heading`}>
        <p className="vo-progress" aria-label={`第 ${step + 1} 步，共 3 步`}>{step + 1} / 3</p>
        <h1 id={`${inputId}-heading`} ref={heading} tabIndex={-1}>{titles[step]}</h1>

        {step === 0 && <>
          <p className="vo-description">Vivic 把一句话变成可以直接使用的卡片和 Space：说清任务，整理结果，留下需要继续处理的内容。</p>
          <HarkSurface className="vo-guide-card" aria-label="Vivic 的基本使用方式">
            <div className="vo-guide-row"><MessageCircle size={20} aria-hidden="true" /><div><strong>直接用自然语言下达任务</strong><p>在底部输入框描述你要做的事，也可以使用语音。</p></div></div>
            <div className="vo-guide-row"><LayoutGrid size={20} aria-hidden="true" /><div><strong>结果收进 Space</strong><p>卡片可以拖动、整理、聚焦，并投到展示窗口继续使用。</p></div></div>
            <div className="vo-guide-row"><FileText size={20} aria-hidden="true" /><div><strong>文件和能力按需接入</strong><p>支持文件、图片、提醒和已连接的生活服务；无需一次配置全部。</p></div></div>
          </HarkSurface>
          <Button variant="ghost" className="vo-example-toggle" aria-expanded={showExample} aria-controls={`${inputId}-example`} onClick={() => setShowExample(value => !value)} disabled={blocked}>{showExample ? "收起示例" : "查看示例"}<HarkIcon name="chevron-down" /></Button>
          {showExample && <HarkSurface className="vo-example-card" id={`${inputId}-example`} aria-label="示例卡片" data-onboarding-example>
            <p className="vo-card-caption">示例卡片 · 不会加入你的 Space</p>
            <h2><HarkIcon name="file" size={20} />便笺</h2>
            <p>今天完成一件要事，留出休息时间。</p>
          </HarkSurface>}
          <div className="vo-actions"><Button onClick={() => move(1)} disabled={blocked}>继续<HarkIcon name="next" /></Button></div>
        </>}

        {step === 1 && <>
          <p className="vo-description">需要 Vivic 理解、生成或总结内容时，连接自己的模型 API Key。暂时不配置也可以先使用基础文字指令，之后再从“设置 → 连接”补上。</p>
          <HarkSurface className="vo-guide-card vo-key-guide" aria-label="API Key 配置说明">
            <div className="vo-guide-row"><KeyRound size={20} aria-hidden="true" /><div><strong>StepFun Coding Plan Key</strong><p>在 StepFun 控制台创建 Key，再粘贴到下方验证。也可以使用已支持的其他模型服务。</p><a href="https://www.stepfun.com/" target="_blank" rel="noopener noreferrer">打开 StepFun 官网</a></div></div>
            <div className="vo-guide-row"><ShieldCheck size={20} aria-hidden="true" /><div><strong>Key 只用于当前服务会话</strong><p>不会写入 Space、卡片或聊天记录；断开连接即可清除。</p></div></div>
          </HarkSurface>
          <div className="vo-connection" aria-live="polite" aria-busy={busy}>
            {online.connection.phase === "checking" && <p className="vo-status">正在检查已有连接…</p>}
            {online.connection.phase === "connecting" && <p className="vo-status">正在验证模型能否响应…</p>}
            {online.connection.phase === "connected" && <p className="vo-status vo-connected"><HarkIcon name="check" />已连接 {online.connection.provider === "stepfun" ? "StepFun" : "GPT"}{online.connection.model && <span className="vo-model">{online.connection.model}</span>}</p>}
            {online.connection.phase === "offline" && <p className="vo-error" role="alert">在线服务暂时不可达，请稍后重试。也可以先体验基础功能。</p>}
            {online.connection.phase === "error" && <p className="vo-error" role="alert">{online.connection.message}</p>}
          </div>
          {!connected && <form onSubmit={submit} className="vo-key-form">
            <label htmlFor={`${inputId}-key`}>StepFun API Key</label>
            <Input id={`${inputId}-key`} type="password" name="vivic-online-key" autoComplete="off" spellCheck={false} autoCapitalize="off" value={online.keyInput} onChange={event => online.setKeyInput(event.target.value)} disabled={blocked || busy} placeholder="输入你的 Key" aria-describedby={`${inputId}-key-note`} />
            <p className="vo-field-note" id={`${inputId}-key-note`}>请确认这是 Coding Plan Key；验证通过后模型才能执行需要 AI 的任务。</p>
            <div className="vo-connect-actions"><Button type="submit" disabled={blocked || busy || !online.keyInput.trim()}>验证并连接</Button>{!busy && <Button variant="ghost" onClick={() => void online.refresh()} disabled={blocked}>检查连接</Button>}</div>
          </form>}
          <div className="vo-actions">
            <Button variant="ghost" onClick={() => move(0)} disabled={blocked}><HarkIcon name="back" />返回</Button>
            {connected && <Button onClick={() => { setBasic(false); move(2); }} disabled={blocked}>继续<HarkIcon name="next" /></Button>}
          </div>
          {!connected && <Button variant="ghost" className="vo-basic" onClick={() => { setBasic(true); setIncludeDraft(false); move(2); }} disabled={blocked}>先体验基础功能</Button>}
        </>}

        {step === 2 && <>
          <p className="vo-description">{basic ? "你可以先用输入框和现有卡片开始；需要 AI 时，再从设置连接模型。" : "模型连接已经就绪。在底部输入一句话，结果会进入 Space。"}</p>
          {!basic && <label className="vo-draft-choice"><input type="checkbox" checked={includeDraft} disabled={blocked} onChange={event => setIncludeDraft(event.target.checked)} /><span>带入便笺示例<small>{ONLINE_STARTER_DRAFT}由你确认发送。</small></span></label>}
          <div className="vo-actions"><Button variant="ghost" onClick={() => move(1)} disabled={blocked}><HarkIcon name="back" />返回</Button><Button onClick={complete} disabled={blocked}>开始使用<HarkIcon name="next" /></Button></div>
        </>}
      </section>
    </div>
  </main>;
}
