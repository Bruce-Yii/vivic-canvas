import { useEffect, useState } from "react";
import { resolveTheme } from "@/motion/motionDirector";
import { useDisplayPreferences, useVivicState } from "@/state/canvasStore";

/** Light/dark actually shown now: "auto" follows the local day schedule, re-evaluated on minute boundaries. */
export const useResolvedTheme = (): "light" | "dark" => {
  const theme = useVivicState((s) => s.ambient.theme);
  const preferences = useDisplayPreferences();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (theme !== "auto") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (timer !== undefined) clearTimeout(timer);
      const current = Date.now();
      setNow(new Date(current));
      // Align to wall-clock minutes, rather than one minute after mounting.
      // Hidden windows resume immediately on visibility/pageshow restoration.
      if (!document.hidden) timer = setTimeout(update, 60_000 - current % 60_000);
    };
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pageshow", update);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pageshow", update);
    };
  }, [theme]);
  return resolveTheme(theme, now, preferences);
};
