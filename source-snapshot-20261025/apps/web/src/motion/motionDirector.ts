import type { AIState } from "@/components/smoothui/ai-core";
import type { VivicState } from "@/state/canvasStore";
import type { DisplayPreferences } from "@/sync/protocol";

/**
 * Motion Director: derives component states from *confirmed* store
 * transitions. It never owns state — it only maps the store onto the locked
 * components (SmoothUI Siri Orb, 流光以太 atmosphere, subtitle layer).
 */

export type DerivedStage = "STANDBY" | "AWAKENING" | "WORKSPACE" | "FOCUS";

export interface OrbDirective {
  visible: boolean;
  size: string;
  state: AIState;
  /** Small feedback orb only appears for speaking/thinking events. */
  feedback: boolean;
}

export const DAY_START_HOUR = 7;
export const DEFAULT_DAY_START = "07:00";
export const DEFAULT_DAY_END = "19:00";

export const deriveStage = (state: VivicState): DerivedStage => {
  if (state.stage !== "WORKSPACE") return state.stage;
  return state.focus ? "FOCUS" : "WORKSPACE";
};

export const deriveOrb = (input: {
  stage: VivicState["stage"];
  speaking: boolean;
  thinking?: boolean;
  listening?: boolean;
}): OrbDirective => {
  const speaky = input.speaking;
  const thinking = input.thinking ?? false;
  const listening = input.listening ?? false;
  switch (input.stage) {
    case "STANDBY":
      return { visible: true, size: "224px", state: listening ? "listening" : thinking ? "thinking" : speaky ? "streaming" : "idle", feedback: false };
    case "AWAKENING":
      // The orb stays visible while its mask reveals the background.
      return {
        visible: true,
        size: "224px",
        state: listening ? "listening" : thinking ? "thinking" : speaky ? "streaming" : "idle",
        feedback: false,
      };
    case "WORKSPACE":
      // Scheme C: no resident orb; brief return while a feedback event plays.
      return {
        visible: speaky || thinking || listening,
        size: listening ? "112px" : thinking ? "96px" : "64px",
        state: listening ? "listening" : thinking ? "thinking" : "streaming",
        feedback: true,
      };
  }
};

export const resolveTheme = (
  theme: VivicState["ambient"]["theme"],
  at: Date = new Date(),
  schedule?: Pick<DisplayPreferences, "dayStart" | "dayEnd">,
): "light" | "dark" => {
  if (theme !== "auto") return theme;
  const minutes = (value: string | undefined, fallback: string) => {
    const time = value && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
    return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  };
  const start = minutes(schedule?.dayStart, DEFAULT_DAY_START);
  const end = minutes(schedule?.dayEnd, DEFAULT_DAY_END);
  const current = at.getHours() * 60 + at.getMinutes();
  // Local wall time, [start, end). A wrapped range continues after midnight;
  // equal endpoints form an empty daylight interval (all-day dark).
  const daylight = start <= end ? current >= start && current < end : current >= start || current < end;
  return daylight ? "light" : "dark";
};
