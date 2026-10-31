import { useEffect, useState } from "react";
import type { CountdownCard } from "@/contracts";
import { renderVivicSpec } from "./vivicGUILibrary";

const formatRemaining = (targetAt: string, now: number): string => {
  const total = Math.max(0, Math.ceil((Date.parse(targetAt) - now) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(seconds)}`
    : `${two(minutes)}:${two(seconds)}`;
};

/**
 * Minimal countdown: ONLY the ticking digits, computed locally from
 * sourceData.targetAt. displayProps is an empty object by contract; nothing
 * else (title / footer / advice) can exist here.
 */
export const CountdownCardView = ({ card }: { card: CountdownCard }) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="vivic-countdown flex w-full items-center justify-center py-1">
      {renderVivicSpec({
        _type: "Col",
        align: "center",
        gap: 0,
        children: [
          {
            _type: "Text",
            value: formatRemaining(card.sourceData.targetAt, card.sourceData.pausedAt ? Date.parse(card.sourceData.pausedAt) : now),
            size: "2xl",
            weight: "semibold",
          },
        ],
      })}
    </div>
  );
};

export { formatRemaining };
