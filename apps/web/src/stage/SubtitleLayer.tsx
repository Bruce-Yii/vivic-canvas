import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { canvasStore, useVivicState, useDisplayPreferences } from "@/state/canvasStore";

/**
 * Bottom-centre transient voice text. No bubble, no avatar, no timestamp.
 * Consecutive `subtitle.show` events replace the current line; the line
 * self-dismisses after durationMs.
 */
export const SubtitleLayer = () => {
  const preferences = useDisplayPreferences();
  const subtitle = useVivicState((s) => s.subtitle);
  const activity = useVivicState((s) => s.activity);
  const reminderAlert = subtitle?.priority === "reminder";
  const line = reminderAlert ? subtitle : activity ?? subtitle;
  const showingActivity = Boolean(activity && line === activity);
  const lineId = line && ("requestId" in line ? line.requestId : line.id);
  const timing = showingActivity && activity?.phase === "speaking" ? activity.speech : undefined;
  const wordStart = timing?.wordStart, wordEnd = timing?.wordEnd;
  const wordActive = wordStart !== undefined && wordEnd !== undefined && wordStart < wordEnd && wordEnd <= (line?.text.length ?? 0);

  useEffect(() => {
    if (!activity) return;
    const timer = setTimeout(() => {
      if (canvasStore.getState().activity?.requestId === activity.requestId) {
        canvasStore.internal({ type: "activity.set", activity: null });
      }
    }, Math.max(0, activity.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [activity]);

  useEffect(() => {
    if (!subtitle) return;
    const timer = setTimeout(
      () => canvasStore.internal({ type: "subtitle.dismiss", id: subtitle.id }),
      subtitle.durationMs,
    );
    return () => clearTimeout(timer);
  }, [subtitle]);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-[7vh] z-40 flex justify-center px-8"
      aria-live="polite"
    >
      <AnimatePresence mode="wait">
        {(preferences.subtitles || reminderAlert) && line && (
          <motion.p
            key={lineId}
            data-vivic-subtitle={lineId}
            data-vivic-reminder-alert={!showingActivity && subtitle?.priority === "reminder" ? "true" : undefined}
            data-vivic-thinking={showingActivity && activity?.phase !== "speaking" ? "true" : undefined}
            data-vivic-speaking={showingActivity && activity?.phase === "speaking" ? "true" : undefined}
            className="vivic-subtitle"
            aria-label={wordActive ? line.text : undefined}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.28, ease: "easeOut" }}
          >
            {wordActive ? <span aria-hidden="true">
              <span className="opacity-60">{line.text.slice(0, wordStart)}</span>
              <span className="font-semibold" data-vivic-spoken-word>{line.text.slice(wordStart, wordEnd)}</span>
              <span className="opacity-60">{line.text.slice(wordEnd)}</span>
            </span> : line.text}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
};
