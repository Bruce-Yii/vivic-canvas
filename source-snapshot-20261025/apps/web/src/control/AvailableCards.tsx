import { CARD_TYPE_LABELS, SCENES, type CardType } from "@/contracts";
import type { ProviderStatus } from "@/ai/api";
import { ONLINE_BUILD } from "@/online/mode";
import { HarkIcon } from "@/components/hark/HarkPrimitives";

type Kind = "local" | "model" | "data" | "network" | "demo";
const special: Partial<Record<CardType, { kind: Kind; description: string }>> = {
  FileCard: { kind: "local", description: "上传文件，预览、下载或交给 Vivic 阅读" },
  TravelOffersCard: { kind: "demo", description: "无需模型体验旅游查询；结果均为模拟数据" },
  ExtensionCard: { kind: "model", description: "导入并启用声明式卡片包后，按卡名创建" },
  CountdownCard: { kind: "local", description: "计时器和事项提醒" },
  TodoCard: { kind: "local", description: "记录与勾选待办任务" },
  NoteCard: { kind: "local", description: "保存文字和笔记" },
  TableCard: { kind: "data", description: "整理你提供的数值" },
  ChartCard: { kind: "data", description: "折线图、柱状图和饼图" },
  WeatherCard: { kind: "network", description: "查询城市或当前位置天气" },
  SearchResultCard: { kind: "network", description: "检索资料并展示真实来源" },
};
const catalog = (Object.keys(CARD_TYPE_LABELS) as CardType[]).map(type => ({
  type, label: CARD_TYPE_LABELS[type],
  ...(special[type] ?? { kind: "model" as const, description: SCENES.find(scene => scene.cardType === type)?.label ?? CARD_TYPE_LABELS[type] }),
}));
const groups = [
  { id: "local", title: "本地指令与演示", kinds: ["local", "demo"] },
  { id: "model", title: "模型场景", kinds: ["model"] },
  { id: "data", title: "数据与联网", kinds: ["data", "network"] },
] as const;

interface AvailableCardsProps {
  backendStatus: "checking" | "online" | "offline";
  provider?: ProviderStatus;
  connectionText: string;
}

/** The same registered types used by the canvas and the model's scene prompt. */
export function AvailableCards({ backendStatus, provider, connectionText }: AvailableCardsProps) {
  const modelReady = backendStatus === "online" && Boolean(provider?.connected);
  const availability = (kind: Kind) => kind === "local" ? "ready"
    : backendStatus === "checking" ? "checking"
      : kind === "model" ? modelReady ? "ready" : "requires-model"
        : backendStatus === "online" ? "conditional" : "requires-backend";
  const statusLabel = (kind: Kind) => {
    const state = availability(kind);
    if (state === "checking") return "检查中";
    if (state === "requires-model") return "需连接当前模型";
    if (state === "requires-backend") return ONLINE_BUILD ? "服务暂不可用" : "需启动本地服务";
    return kind === "network" ? "需联网" : kind === "data" ? "需提供数据" : kind === "demo" ? "DEMO · 无需模型" : "可用";
  };

  const Container = ONLINE_BUILD ? "details" : "section";
  return <Container className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50/50 p-3" data-vivic-available-cards>
    {ONLINE_BUILD && <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm">支持哪些卡片<HarkIcon name="down" /></summary>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">支持的卡片</h3>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-neutral-500">{catalog.length} 类已接入</span>
      </div>
    </div>
    <p className="mt-1 text-xs text-neutral-600" role="status" data-vivic-card-model-status>{connectionText}</p>
    {groups.map(group => {
      const cards = catalog.filter(card => (group.kinds as readonly Kind[]).includes(card.kind));
      return <div key={group.id} className="mt-3" data-vivic-card-group={group.id}>
        <p className="text-xs font-medium text-neutral-700">{group.title} · {cards.length}</p>
        <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {cards.map(card => {
            const state = availability(card.kind);
            const unavailable = state === "requires-model" || state === "requires-backend";
            return <li key={card.type} className={`rounded-md border border-neutral-200 p-2 ${unavailable ? "bg-neutral-100/70" : "bg-white"}`}
              data-vivic-available-card={card.type} data-availability={state}>
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <span className={`text-xs font-medium ${unavailable ? "text-neutral-500" : "text-neutral-900"}`}>{card.label}</span>
                <span className={`text-[10px] ${state === "ready" ? "text-emerald-700" : "text-neutral-500"}`}>{statusLabel(card.kind)}</span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">{card.description}</p>
            </li>;
          })}
        </ul>
      </div>;
    })}
    <p className="mt-3 text-xs leading-relaxed text-neutral-500">
      重要日期倒计时和自然语言整理需连接模型。表格、图表使用你提供的数据；文献、资讯与照片需要已有内容、链接或手动添加的照片。联网卡片还取决于对应服务是否可达。
    </p>
  </Container>;
}
