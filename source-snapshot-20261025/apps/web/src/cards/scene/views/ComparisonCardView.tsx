import { useLayoutEffect, useState } from "react";
import { ArrowDown, ArrowUp, Lightbulb, Trophy } from "lucide-react";
import type { ComparisonCard } from "@/contracts";
import { SceneCardShell } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import type { CardViewProps } from "../types";
import "./ComparisonCardView.css";

type Comparison = ComparisonCard["displayProps"];
type Option = Comparison["options"][number];
type Criterion = Comparison["criteria"][number];
type Value = Criterion["values"][number];

const isNumber = (value: Value | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/** Indexes holding the best numeric value; none when there is no direction, too few numbers, or a tie across all. */
export function bestIndexes(criterion: Pick<Criterion, "values" | "better">): Set<number> {
  if (!criterion.better) return new Set();
  const numbers = criterion.values.flatMap((value, index) => isNumber(value) ? [{ value, index }] : []);
  if (numbers.length < 2) return new Set();
  const values = numbers.map(item => item.value);
  const target = criterion.better === "higher" ? Math.max(...values) : Math.min(...values);
  if (values.every(value => value === target)) return new Set();
  return new Set(numbers.filter(item => item.value === target).map(item => item.index));
}

const PLAIN = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const COMPACT = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 });
const formatNumber = (value: number) => Math.abs(value) >= 1e8 ? COMPACT.format(value) : PLAIN.format(value);
/** Latin units take a space ("16 GB"); CJK units and symbols attach ("5,200元", "35%"). */
const withUnit = (text: string, unit?: string) => !unit ? text : /^[A-Za-z]/.test(unit) ? `${text} ${unit}` : `${text}${unit}`;

export function formatComparisonValue(value: Value | undefined, unit?: string): string | null {
  if (isNumber(value)) return withUnit(formatNumber(value), unit);
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

/** Display: whether the criteria region actually scrolls, so the header only turns opaque/sticky when it must. */
function useOverflowing(enabled: boolean): [(node: HTMLDivElement | null) => void, boolean] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    if (!enabled || !element) return;
    const check = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [enabled, element]);
  return [setElement, enabled && overflowing];
}

function OptionHead({ option, chosen }: { option: Option; chosen: boolean }) {
  return <span className="vivic-compare-option">
    <span className="vivic-compare-option-name"><span>{option.name}</span>{chosen && <span className="vivic-compare-chip">推荐</span>}</span>
    {option.note && <span className="vivic-compare-option-note" title={option.note}>{option.note}</span>}
  </span>;
}

function ValueCell({ value, unit, best }: { value: Value | undefined; unit?: string; best: boolean }) {
  const text = formatComparisonValue(value, unit);
  if (text === null) return <span className="vivic-compare-value" data-empty aria-label="无数据"><span>—</span></span>;
  return <span className="vivic-compare-value" data-best={best || undefined}>
    {best && <Trophy size={12} strokeWidth={2.2} aria-hidden />}<span>{text}</span>{best && <span className="sr-only">（最优）</span>}
  </span>;
}

function BetterHint({ better }: { better: Criterion["better"] }) {
  if (!better) return null;
  const Icon = better === "higher" ? ArrowUp : ArrowDown;
  const label = better === "higher" ? "越高越好" : "越低越好";
  return <span className="vivic-compare-better" title={label} aria-label={label} role="img"><Icon size={11} strokeWidth={2.4} aria-hidden /></span>;
}

export function ComparisonCardView({ card, height }: CardViewProps<"ComparisonCard">) {
  const { title, options, criteria, recommendation, chosenId } = card.displayProps;
  const editor = useCardEditor(card);
  const fixed = height !== undefined;
  const [scrollRef, overflowing] = useOverflowing(fixed);
  const best = criteria.map(criterion => bestIndexes(criterion));
  const lastRow = criteria.length - 1;
  // Short Display cards keep the table region usable by trimming the recommendation to one line.
  const recLines = fixed ? (height < 220 ? 1 : 2) : undefined;
  const pick = (option: Option) => editor.patch({ chosenId: option.id === chosenId ? undefined : option.id });
  const head = (option: Option) => {
    const chosen = option.id === chosenId;
    return editor.editable
      ? <button type="button" className="vivic-compare-pick nodrag nopan" aria-pressed={chosen} onClick={() => pick(option)}
        aria-label={`${chosen ? "取消推荐" : "设为推荐"}：${option.name}`} data-compare-pick={option.id}>
        <OptionHead option={option} chosen={chosen} />
      </button>
      : <OptionHead option={option} chosen={chosen} />;
  };

  return <SceneCardShell card={card} height={height} title={title}
    meta={fixed ? undefined : `${options.length} 个方案 · ${criteria.length} 项指标`}>
    <div className="vivic-compare" data-options={options.length} data-chosen-id={chosenId}>
      <div ref={scrollRef} className={`vivic-compare-scroll${fixed ? " vivic-scene-scroll nowheel" : ""}`} data-overflowing={overflowing || undefined}>
        <table className="vivic-compare-table" data-compare-table>
          <colgroup><col className="vivic-compare-col-name" />{options.map(option => <col key={option.id} />)}</colgroup>
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">指标</span></th>
              {options.map(option => <th key={option.id} scope="col" data-chosen={option.id === chosenId || undefined} data-compare-option={option.id}>{head(option)}</th>)}
            </tr>
          </thead>
          <tbody>
            {criteria.map((criterion, row) => <tr key={criterion.id} data-compare-criterion={criterion.id}>
              <th scope="row"><span className="vivic-compare-name"><span>{criterion.name}</span><BetterHint better={criterion.better} /></span></th>
              {options.map((option, index) => <td key={option.id} data-chosen={option.id === chosenId || undefined} data-last-row={row === lastRow || undefined}>
                <ValueCell value={criterion.values[index]} unit={criterion.unit} best={best[row]!.has(index)} />
              </td>)}
            </tr>)}
          </tbody>
        </table>
        <div className="vivic-compare-stack" data-compare-stack>
          {options.map((option, index) => <section key={option.id} className="vivic-compare-card" data-chosen={option.id === chosenId || undefined} aria-label={option.name}>
            <header className="text-[13px] font-semibold">{head(option)}</header>
            <dl>{criteria.map((criterion, row) => <div key={criterion.id}>
              <dt><span className="vivic-compare-name"><span>{criterion.name}</span><BetterHint better={criterion.better} /></span></dt>
              <dd data-numeric={isNumber(criterion.values[index]) || undefined}><ValueCell value={criterion.values[index]} unit={criterion.unit} best={best[row]!.has(index)} /></dd>
            </div>)}</dl>
          </section>)}
        </div>
      </div>
      {editor.editable && <p className="vivic-scene-muted m-0 text-[11.5px]" data-compare-hint>点击方案名可设为推荐，再次点击取消。</p>}
      {recommendation && <div className="vivic-compare-rec" data-compare-recommendation>
        <Lightbulb size={14} aria-hidden /><p title={fixed ? recommendation : undefined} style={recLines ? { WebkitLineClamp: recLines } : undefined}>{recommendation}</p>
      </div>}
    </div>
  </SceneCardShell>;
}
