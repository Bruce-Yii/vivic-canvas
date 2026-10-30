import { useContext, useEffect, useSyncExternalStore } from "react";
import { resolvePointer, validateInstance, type CardDefinition, type UiBlock } from "@vivic/card-runtime";
import { Puzzle } from "lucide-react";
import { SceneCardShell, SceneEmpty } from "@/cards/scene/SceneCardShell";
import { useCardEditor } from "@/cards/scene/cardContext";
import type { CardViewProps } from "@/cards/scene/types";
import { extensionDefinitions } from "./definitionStore";
import { SchemaForm } from "./SchemaForm";
import { OfficePlannerCardView } from "@/cards/office/OfficePlannerCardView";
import { useOfficePlannerKind } from "@/cards/office/useOfficePlannerKind";
import { MediaImage } from "@/cards/scene/MediaImage";
import { HostedDefinitionContext } from "./HostedDefinitionScope";
import "./extensions.css";

const display = (value: unknown): string => value === undefined || value === null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);
const httpsUrl = (value: unknown) => {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
};
function Block({ block, root, allowNetwork }: { block: UiBlock; root: unknown; allowNetwork: boolean }) {
  const value = block.bind ? resolvePointer(root, block.bind) : block.text;
  const text = display(value), label = block.label;
  switch (block.component) {
    case "Header": return <h4 className="text-lg font-semibold break-words">{text}</h4>;
    case "Metric": return <div><p className="vivic-scene-muted text-xs">{label}</p><strong className="text-3xl tabular-nums break-words">{text}</strong></div>;
    case "KeyValue": return <div className="flex justify-between gap-3 text-sm"><span className="vivic-scene-muted max-w-[40%] shrink-0 truncate" title={label}>{label}</span><span className="min-w-0 break-words text-right">{text}</span></div>;
    case "Badge": return <span className="vivic-scene-badge">{label ? `${label} · ` : ""}{text}</span>;
    case "List": return Array.isArray(value) && value.length ? <ul className="space-y-2 text-sm list-disc pl-4">{value.map((v, i) => <li key={i} className="break-words">{display(v)}</li>)}</ul> : <SceneEmpty>暂无内容</SceneEmpty>;
    case "Image": {
      if (!allowNetwork) return <SceneEmpty>{label ?? "图片"} · DEMO 预览不加载远程图片</SceneEmpty>;
      const url = httpsUrl(value);
      return url ? <MediaImage className="vivic-extension-image" src={url} alt={label ?? "卡片图片"} fit="contain" /> : <SceneEmpty>{label ?? "图片不可用"}</SceneEmpty>;
    }
    case "Link": { const url = httpsUrl(value); return url && allowNetwork ? <a className="vivic-scene-action break-all" href={url} target="_blank" rel="noopener noreferrer">{label ?? url}</a> : <span className="vivic-scene-muted text-xs">{label ?? "链接"}{allowNetwork ? "不可用" : " · DEMO 链接未打开"}</span>; }
    case "Progress": {
      const progress = typeof value === "number" ? Math.min(100, Math.max(0, value)) : 0;
      return <div className="space-y-1"><p className="text-xs">{label} {progress}%</p><progress className="vivic-extension-progress w-full" style={{ accentColor: "var(--vivic-accent, #7c68df)" }} max={100} value={progress} aria-label={label ?? "进度"} /></div>;
    }
    case "Table": return Array.isArray(value) && value.length ? <div className="vivic-extension-table" tabIndex={0} role="region" aria-label={label ?? "卡片数据表"}><table className="w-full text-xs"><thead><tr>{block.columns?.map(c => <th scope="col" className="p-2 text-left" key={c.field}>{c.label}</th>)}</tr></thead><tbody>{value.map((row, i) => <tr key={i}>{block.columns?.map(c => <td className="p-2 break-words border-t border-[var(--border)]" key={c.field}>{display(typeof row === "object" && row !== null && Object.hasOwn(row, c.field) ? (row as Record<string, unknown>)[c.field] : undefined)}</td>)}</tr>)}</tbody></table></div> : <SceneEmpty>暂无数据</SceneEmpty>;
  }
}
/** Explicit definition is used only by the isolated Test Space. */
export function ExtensionCardView({ card, height, definition: previewDefinition }: CardViewProps<"ExtensionCard"> & { definition?: CardDefinition }) {
  const hosted = useContext(HostedDefinitionContext);
  useSyncExternalStore(extensionDefinitions.subscribe, extensionDefinitions.snapshot, extensionDefinitions.snapshot);
  useEffect(() => { if (!previewDefinition && !hosted) void extensionDefinitions.ready(); }, [previewDefinition, hosted]);
  const editor = useCardEditor(card), definition = previewDefinition ?? (hosted ? hosted.get(card.displayProps.def) : extensionDefinitions.get(card.displayProps.def));
  const officeKind = useOfficePlannerKind(definition);
  let problem: string | null = definition ? null : hosted?.loading ? "正在读取空间卡片定义…" : hosted?.error ?? "卡片定义缺失或已禁用。在设置重新导入原包或启用即可恢复；原始卡片数据已保留。";
  if (definition) { try { validateInstance(definition, card.displayProps); } catch (cause) { problem = cause instanceof Error ? cause.message : String(cause); } }
  if (!problem && definition && officeKind) return <OfficePlannerCardView card={card} height={height} definition={definition} kind={officeKind} preview={Boolean(previewDefinition)} />;
  return <SceneCardShell card={card} height={height} icon={Puzzle} harkIcon="apps" kicker="扩展卡片" title={definition?.manifest.name ?? card.displayProps.def.id}
    badge={problem ? "暂不可用" : previewDefinition ? "DEMO" : `v${definition?.manifest.version}`} badgeTone={problem ? "caution" : "accent"}
    footer={problem ? undefined : <span>{previewDefinition ? "预览" : hosted ? "空间卡片包" : "本地卡片包"}</span>}>
    {problem ? <SceneEmpty>{problem}</SceneEmpty> : <div className={`vivic-extension-content space-y-4${height !== undefined ? " vivic-scene-scroll nowheel" : ""}`} data-extension-rendered={card.displayProps.def.id}>
      {definition!.ui.components.map((block, i) => <Block key={i} block={block} root={card.displayProps} allowNetwork={!previewDefinition} />)}
      {editor.editable && <details><summary className="vivic-scene-action cursor-pointer">编辑参数和个人状态</summary><div className="space-y-4 mt-3">
        <SchemaForm schema={definition!.configSchema} value={card.displayProps.config} onChange={config => { editor.patch({ config }); }} />
        <SchemaForm label="个人状态" schema={definition!.stateSchema} value={card.displayProps.state} onChange={state => { editor.patch({ state }); }} />
      </div></details>}
    </div>}
  </SceneCardShell>;
}
