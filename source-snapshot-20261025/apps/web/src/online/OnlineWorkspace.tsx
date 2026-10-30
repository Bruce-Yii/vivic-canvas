import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { OnlineOnboarding } from "@/onboarding/OnlineOnboarding";
import { prepareTemplateDraft } from "@/control/draftTransfer";
import { cancelVoiceInput } from "@/ai/voiceInput";
import { cancelSpeech } from "@/ai/speech";
import { cancelWakeActivity } from "@/ai/wakeActivity";
import { ONLINE_BUILD } from "./mode";
import { useResolvedTheme } from "@/stage/useResolvedTheme";

export const ONLINE_WELCOME_KEY = "vivic.online.welcome.v1";
export const OnlineWorkspaceSuspended = createContext(false);
export const showOnlineWelcome = () => window.dispatchEvent(new Event("vivic:show-online-welcome"));
function completed() { try { return localStorage.getItem(ONLINE_WELCOME_KEY) === "done"; } catch { return false; } }

/** Revisiting the guide hides, but never unmounts, an existing owner or settings drafts. */
export function OnlineWorkspace({ children }: { children: ReactNode }) {
  const theme = useResolvedTheme();
  const parentSuspended = useContext(OnlineWorkspaceSuspended);
  const [started, setStarted] = useState(() => !ONLINE_BUILD || completed());
  const [show, setShow] = useState(() => ONLINE_BUILD && !completed());
  useEffect(() => {
    if (!ONLINE_BUILD) return;
    const open = () => { cancelVoiceInput(); cancelWakeActivity(); cancelSpeech(); setShow(true); };
    window.addEventListener("vivic:show-online-welcome", open);
    return () => window.removeEventListener("vivic:show-online-welcome", open);
  }, []);
  const finish = (draft?: string) => {
    if (draft) prepareTemplateDraft(draft);
    try { localStorage.setItem(ONLINE_WELCOME_KEY, "done"); } catch { /* Current tab still works. */ }
    setStarted(true); setShow(false);
  };
  return <>
    {started && <OnlineWorkspaceSuspended.Provider value={show || parentSuspended}><div className="online-workspace-host" hidden={show} inert={show}>{children}</div></OnlineWorkspaceSuspended.Provider>}
    {show && <OnlineOnboarding theme={theme} onComplete={finish} onCancel={started ? () => setShow(false) : undefined} />}
  </>;
}
