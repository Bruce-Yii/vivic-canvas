import { CitySchema } from "./weather.js";
import { isMixedInstruction } from "./numeric.js";

/** `here` = no city named: the data client estimates the device region from its network. */
export type WeatherInput = { kind: "weather"; city: string } | { kind: "here" } | { kind: "clarify"; message: string };
const cityPrompt = "请明确城市名，例如「上海,上海市天气」。";
// Not a valid city, so it re-asks with cityPrompt; a bare 天气 would now trigger the region lookup.
const REASK_CITY = "？天气";

const HERE = /^(?:今天|现在|当前|实时|这里|这边|当地|本地|附近|我这|我这里|我这边|我们这|我们这里|我们这边|所在地|外面|外边|户外|室外)$/;
// Everyday temperature questions without 天气 about where the user is: 外面冷不冷 / 现在多少度.
// With any other subject (水烧到多少度, 北京热吗) the rules stay out and the model decides.
const FEELS = /^(?:请问|问一下)?\s*(.*?)\s*(?:今天|现在|当前)?\s*(?:的)?(?:温度|气温)?\s*(?:冷不冷|热不热|冷吗|热吗|多少度|几度)(?:啊|呀|呢)?$/u;

/** Only current weather. A request may name the city before or after 天气卡片, or none at all. */
export function parseWeatherInput(text: string): WeatherInput | null {
  if (!/天气|气温/.test(text)) {
    const feels = text.trim().replace(/[。？?！!]$/, "").match(FEELS);
    if (!feels || text.length > 30) return null;
    const place = feels[1]!.replace(/(?:今天|现在|当前)$/, "").replace(/的$/, "").trim();
    return !place || HERE.test(place) ? { kind: "here" } : null;
  }
  let raw = text.trim().replace(/^(?:请帮我|请|帮我|给我)\s*/, "")
    .replace(/^(?:查询|查一下|查看|查查|显示|查)\s*/, "")
    .replace(/[。？?！!]$/, "").trim();
  // Card operations belong to reference resolution, not a new weather lookup.
  if (/^(?:删除|删掉|删了|删|移除|去掉|聚焦|放大|展开|收起|折叠)/.test(raw)) return null;
  if ((raw.match(/天气|气温/g)?.length ?? 0) > 1 || isMixedInstruction(raw.replace(/天气|气温/g, ""))
    || /[；;\n]|然后|顺便|再(?:查|画|建|删)|并(?:查|画|建|删)|以及|同时|、/.test(raw)) {
    return { kind: "clarify", message: "请一次查询一个城市的当前天气，其他操作请另发指令；本次没有执行任何部分。" };
  }
  if (/明天|后天|昨天|未来|下周|本周|一周|小时|预报|早上|晚上|今晚/.test(raw)) {
    return { kind: "clarify", message: "目前支持城市的当前天气；请写成「城市当前天气」。" };
  }
  raw = raw.replace(/^(?:创建|新建|添加|新增)(?:一?[张个])?\s*/, "");
  const cityAfter = raw.match(/^天气(?:卡片|卡)\s*[:：]\s*(.+)$/u);
  const cityBefore = raw.match(/^(.*?)\s*(?:(?:的)?(?:今天|现在|当前|实时))?\s*(?:的)?(?:天气|气温)(?:卡片|卡)?(?:怎么样|如何)?$/u);
  let city = (cityAfter?.[1] ?? cityBefore?.[1] ?? "").trim();
  city = city.replace(/(?:的)?(?:今天|现在|当前|实时)$/, "").replace(/的$/, "").trim();
  if (!city || HERE.test(city)) return { kind: "here" };
  if (!CitySchema.safeParse(city).success) return { kind: "clarify", message: cityPrompt };
  return { kind: "weather", city };
}

/** Weather follow-ups stay with the real data adapter, without asking an LLM to invent data. */
export function continueWeatherInput(answer: string, utterance: string): string | null {
  const original = parseWeatherInput(utterance);
  // An unsupported forecast or compound request cannot become a partial
  // current-weather lookup just because a city was supplied afterwards.
  if (!original || (original.kind === "clarify" && original.message !== cityPrompt)) return null;
  if (/天气|气温/.test(answer)) return answer;
  const city = answer.trim().replace(/[。！!]$/, "");
  if (!CitySchema.safeParse(city).success || /待办|删除|聚焦|提醒|倒计时|然后|同时|不要|不查/.test(city)) return REASK_CITY;
  return `${city}天气`;
}
