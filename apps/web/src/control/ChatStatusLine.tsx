import { HarkIcon } from "@/components/hark/HarkPrimitives";

/**
 * The single status slot above the composer. Progress, a preset, a model first
 * sentence, a question and an error all share this one line; the composer must
 * not render a second "正在处理… N 秒" row while it is visible.
 */
export const ChatStatusLine = ({ text, visible, busy, onCancel }: {
  text: string | null;
  visible: boolean;
  busy: boolean;
  onCancel: () => void;
}) => {
  if (!text) return null;
  return (
    <p className="vivic-chat-status" role="status" aria-live="polite" aria-busy={busy}
      data-visible={visible || undefined} data-vivic-command-feedback>
      <span>{text}</span>
      {busy && <button type="button" className="vivic-chip vivic-chip-quiet vivic-chat-status-cancel"
        onClick={onCancel} data-vivic-command-cancel>
        <HarkIcon name="close" size={14} aria-hidden="true" />取消
      </button>}
    </p>
  );
};
