import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Circle, CircleCheck } from "lucide-react";
import type { RoadmapCard } from "@/contracts";
import { SceneCardShell, SceneEmpty } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import type { CardViewProps } from "../types";
import "./RoadmapCardView.css";

type Phase = RoadmapCard["displayProps"]["phases"][number];
type Milestone = Phase["milestones"][number];

const STATUS_LABEL: Record<Phase["status"], string> = { done: "已完成", active: "进行中", planned: "计划中" };
const NEXT_STATUS: Record<Phase["status"], Phase["status"]> = { planned: "active", active: "done", done: "planned" };
/** Height reserved for the "+N 项" line at the bottom of a clipped milestone list. */
const MORE_ROW = 20;

/**
 * Display: milestones that would be cut off by the fixed-height column are
 * hidden with visibility (layout is kept, so re-measuring is stable) and
 * counted per phase, so the column ends with "+N 项" instead of a cut row.
 */
function useClippedRows(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Record<string, number>>({});
  const measure = useCallback(() => {
    const root = ref.current;
    if (!root) return;
    const next: Record<string, number> = {};
    root.querySelectorAll<HTMLElement>("[data-clip-list]").forEach(list => {
      const limit = list.clientHeight;
      const rows = Array.from(list.children).filter((row): row is HTMLElement => row instanceof HTMLElement && row.hasAttribute("data-clip-row"));
      if (!limit || !rows.length) return;
      const fit = (reserve: number) => rows.filter(row => row.offsetTop + row.offsetHeight <= limit - reserve + 1).length;
      let shown = fit(0);
      if (shown < rows.length) shown = fit(MORE_ROW);
      if (shown < rows.length) next[list.dataset.clipList ?? ""] = rows.length - shown;
    });
    setHidden(prev => {
      const keys = Object.keys(next);
      return keys.length === Object.keys(prev).length && keys.every(key => prev[key] === next[key]) ? prev : next;
    });
  }, []);
  useLayoutEffect(() => { if (enabled) measure(); });
  useEffect(() => {
    const root = ref.current;
    if (!enabled || !root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    return () => observer.disconnect();
  }, [enabled, measure]);
  return { ref, hidden: enabled ? hidden : {} };
}

export function RoadmapCardView({ card, height }: CardViewProps<"RoadmapCard">) {
  const { title, phases } = card.displayProps;
  const editor = useCardEditor(card);
  const fixed = height !== undefined;
  const { ref, hidden } = useClippedRows(editor.mode === "display" && fixed);
  const milestones = phases.flatMap(phase => phase.milestones);
  const done = milestones.filter(item => item.done).length;
  const updatePhase = (id: string, change: (phase: Phase) => Phase) => editor.patch({ phases: phases.map(phase => phase.id === id ? change(phase) : phase) });
  return <SceneCardShell card={card} height={height} title={title}
    badge={milestones.length ? `${done}/${milestones.length} 里程碑` : `${phases.length} 个阶段`}
    badgeTone={milestones.length > 0 && done === milestones.length ? "positive" : "accent"}>
    {phases.length === 0 ? <SceneEmpty>还没有规划阶段</SceneEmpty>
      : <div ref={ref} className="vivic-roadmap">
        <ol className={`vivic-roadmap-phases${fixed ? " vivic-scene-scroll nowheel" : ""}`} data-many={phases.length > 4 || undefined}>
          {phases.map(phase => {
            const clipped = hidden[phase.id] ?? 0;
            const visible = phase.milestones.length - clipped;
            return <li key={phase.id} className="vivic-roadmap-phase" data-status={phase.status} data-roadmap-phase={phase.id}>
              {editor.editable
                ? <button type="button" className="vivic-roadmap-status nodrag nopan" data-status={phase.status}
                  aria-label={`${phase.name}：${STATUS_LABEL[phase.status]}，点按切换为${STATUS_LABEL[NEXT_STATUS[phase.status]]}`}
                  onClick={() => updatePhase(phase.id, row => ({ ...row, status: NEXT_STATUS[row.status] }))}>{STATUS_LABEL[phase.status]}</button>
                : <span className="vivic-roadmap-status" data-status={phase.status}>{STATUS_LABEL[phase.status]}</span>}
              <strong className="vivic-roadmap-name vivic-scene-clamp-2">{phase.name}</strong>
              {phase.period && <span className="vivic-roadmap-period">{phase.period}</span>}
              {phase.goal && <p className="vivic-roadmap-goal vivic-scene-clamp-2">{phase.goal}</p>}
              {phase.milestones.length > 0
                ? <ul className="vivic-roadmap-milestones" data-clip-list={phase.id}>
                  {phase.milestones.map((item, index) => <li key={item.id} data-clip-row data-clipped={index >= visible || undefined} aria-hidden={index >= visible || undefined}>
                    <MilestoneRow item={item} editable={editor.editable}
                      onToggle={() => updatePhase(phase.id, row => ({ ...row, milestones: row.milestones.map(entry => entry.id === item.id ? { ...entry, done: !entry.done } : entry) }))} />
                  </li>)}
                  {clipped > 0 && <li className="vivic-roadmap-more" data-roadmap-more={clipped}>+{clipped} 项</li>}
                </ul>
                : <span className="vivic-roadmap-none">暂无里程碑</span>}
            </li>;
          })}
        </ol>
      </div>}
  </SceneCardShell>;
}

function MilestoneRow({ item, editable, onToggle }: { item: Milestone; editable: boolean; onToggle: () => void }) {
  const content = <>
    {item.done ? <CircleCheck size={14} className="vivic-roadmap-check" aria-hidden /> : <Circle size={14} className="vivic-roadmap-open" aria-hidden />}
    <span className="vivic-scene-clamp-2">{item.text}</span>
  </>;
  return editable
    ? <button type="button" role="checkbox" aria-checked={item.done} className="vivic-roadmap-milestone nodrag nopan" data-done={item.done || undefined}
      data-roadmap-milestone={item.id} onClick={onToggle}>{content}</button>
    : <div className="vivic-roadmap-milestone" data-done={item.done || undefined} data-roadmap-milestone={item.id} title={item.text}>{content}</div>;
}
