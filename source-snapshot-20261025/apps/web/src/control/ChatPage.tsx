import { useEffect, useState, type ReactNode } from "react";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import type { ResolvedCard } from "@/commands/references";
import type { Attachment } from "@/ai/attachments";
import type { ControlHost } from "@/sync/controlHost";
import { ChatComposer, type ClarifyState } from "./ChatComposer";
import { UserCardLayer, useUserPageDrop } from "./UserCardLayer";
import { UserCanvasControls } from "./UserCanvasControls";
import { ConnectedSources } from "@/connections/ConnectedSources";
import { FileUploadButton } from "@/files/FileUploadButton";

interface ChatPageProps {
  hidden: boolean;
  host: ControlHost;
  theme: "light" | "dark";
  feedback: string | null;
  notice?: ReactNode;
  disabled: boolean;
  ownerKey: string;
  clarify: ClarifyState | null;
  suggestions: string[];
  backendOnline: boolean | null;
  busy: boolean;
  onSubmit: (text: string, attachments?: Attachment[]) => void;
  onPickClarify: (candidate: ResolvedCard) => void;
  onPreviewClarify: (candidate: ResolvedCard) => void;
  onCancelClarify: () => void;
  onCancel: () => void;
  onOpenSettings: () => void;
  onOpenDisplay: () => void;
}

const STATUS_VISIBLE_MS = 6000;

/**
 * 用户使用页: the shared background, settings and Space controls
 * and one text/voice input. No conversation is kept — results appear on the
 * Display. Cards the user drags in from the Display float where they land.
 */
export const ChatPage = ({ hidden, host, theme, feedback, notice, onOpenSettings, onOpenDisplay, ...composer }: ChatPageProps) => {
  const drop = useUserPageDrop(host);
  const [fileMessage, setFileMessage] = useState("");
  useEffect(() => {
    if (!fileMessage.startsWith("已保存")) return;
    const timer = setTimeout(() => setFileMessage(""), STATUS_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [fileMessage]);
  // One transient status line (progress, a question, an error), never a log.
  const [fresh, setFresh] = useState(false);
  const sticky = composer.busy || Boolean(composer.clarify);
  useEffect(() => {
    // Reveal each new status, then let it fade; the text stays for assistive tech.
    // oxlint-disable-next-line react/set-state-in-effect
    setFresh(Boolean(feedback));
    if (!feedback) return;
    const timer = setTimeout(() => setFresh(false), STATUS_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [feedback]);

  return (
    <div className="vivic-chat" hidden={hidden} data-vivic-chat {...drop.handlers}>
      <UserCardLayer host={host} theme={theme} layerRef={drop.layerRef} receiving={drop.receiving} notice={drop.notice} onNotice={drop.setNotice} />
      <header className="vivic-chat-header">
        <button type="button" className="vivic-round-button" onClick={onOpenSettings}
          aria-label="设置" title="设置" data-vivic-open-settings>
          <HarkIcon name="gear" size={20} aria-hidden="true" />
        </button>
        <UserCanvasControls host={host} theme={theme} onOpenDisplay={onOpenDisplay} onBeforeClear={composer.onCancel} />
        {notice}
      </header>
      <div className="vivic-chat-space" />
      <div className="vivic-chat-footer">
        {fileMessage && <p className="vivic-file-message vivic-upload-status" role="status">{fileMessage}</p>}
        <p className="vivic-chat-status" role="status" aria-live="polite" aria-busy={composer.busy}
          hidden={!feedback} data-visible={(fresh || sticky) || undefined} data-vivic-command-feedback>{feedback}</p>
        <ChatComposer {...composer} menuActions={close => <>
          <FileUploadButton host={host} disabled={composer.disabled || composer.busy} compact onPick={close} onStatus={setFileMessage} />
          <ConnectedSources host={host} disabled={composer.disabled} onConfigure={onOpenSettings} />
        </>} />
      </div>
    </div>
  );
};
