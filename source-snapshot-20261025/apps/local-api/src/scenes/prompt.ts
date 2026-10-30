import { SCENES } from "@vivic/contracts";

/** Planner instructions for scene cards. One table, the same registry the UI renders from. */
const DATA: Record<(typeof SCENES)[number]["id"], string> = {
  travel_offers: `{"kind":"hotel|flight|poi","destination":"城市","origin?":"出发城市","startDate?":"YYYY-MM-DD","dateText?":"用户原文日期，如下周","nights?":2,"budget?":500,"partySize?":2}`,
  countdown: `{"title":"生日","targetDate":"YYYY-MM-DD","targetTime?":"HH:MM","note?":""}`,
  academic_paper: `{"title":"","authors?":[""],"venue?":"","year?":2017,"abstract?":"","keyPoints?":[""],"doi?":"10.x/…","url?":"https://…","tags?":[""]}`,
  photo_gallery: `{"title":"照片墙","images?":[{"url":"https://…","caption?":""}]}`,
  weekly_schedule: `{"title":"","weekStart?":"YYYY-MM-DD(周一)","events":[{"day":1到7或"date":"YYYY-MM-DD","start?":"HH:MM","end?":"HH:MM","title":"","location?":""}]}`,
  todo_list: `{"title?":"","items":["任务"或{"text":"","done":false}]}`,
  project_roadmap: `{"title":"","phases":[{"name":"","period?":"第1个月","status?":"done|active|planned","goal?":"","milestones?":["里程碑"]}]}`,
  data_visualization: `{"title?":"","chartKind":"line|bar|pie","points":[{"x":"周一","y":3.5}],"xLabel?":"","yLabel?":""}`,
  news_summary: `{"headline":"","source?":"","publishedAt?":"YYYY-MM-DD","summary":"","keyPoints?":[""],"url?":"https://…"}`,
  historical_timeline: `{"title":"","events":[{"date":"YYYY|YYYY-MM|YYYY-MM-DD","title":"","description?":""}]}`,
  quote_note: `{"text":"","author?":"","source?":"","tag?":""}`,
  photo_story: `{"title":"","slides":[{"heading?":"","text":"","imageUrl?":"https://…"}]}`,
  activity_feed: `{"title":"最近动态","live?":true,"items?":[{"kind?":"done|update|create|comment|alert|event","text":"","time?":"昨天 18:00"}]}`,
  goal_progress: `{"title":"","current":18,"target":50,"unit?":"本","deadline?":"YYYY-MM-DD","note?":""}`,
  habit_tracking: `{"habit":"","checkins?":["YYYY-MM-DD"]}`,
  book_record: `{"title":"","author?":"作者姓名字符串","status?":"want|reading|paused|finished","currentPage?":86,"totalPages?":240}`,
  monthly_calendar: `{"title?":"","month?":"YYYY-MM","events":[{"date":"YYYY-MM-DD","title":"","time?":"HH:MM"}]}`,
  option_comparison: `{"title":"","options":["A","B"],"criteria":[{"name":"价格","values":[5200,4600],"better?":"lower","unit?":"元"}],"recommendation?":"","chosen?":"B"}`,
  web_bookmark: `{"url":"https://…","title?":"","siteName?":"","description?":"","tags?":[""]}`,
  photo_memory: `{"title":"","date?":"YYYY-MM-DD","caption?":"","imageUrl?":"https://…"}`,
  single_notification: `{"title":"","body?":"","level?":"info|success|warning|error"}`,
};

const INTENT: Record<(typeof SCENES)[number]["id"], string> = {
  travel_offers: "查询酒店/航班/景点，仅提取用户明确给出的查询条件。酒店须日期和晚数；航班须日期与出发地；缺一项只问该项。用户只说下周/下个月等模糊范围时仅填dateText原文，必须省略startDate，不能从范围里自选某一天。startDate仅用于有依据的具体日期或明天/下周三等确切相对日。不生成酒店名称、价格、评分、链接、库存或items，结果由服务提供；默认是明确标注的DEMO",
  countdown: "关注距离某个日期还剩多久（生日/考试/纪念日/假期），包括“离…还有多少天”这类提问：建卡，并在 spokenText 里直接说出天数。用户说“还有 N 天”时 targetDate 就是 today 加 N 天（如 today=2026-10-17、还有 25 天 → 2026-11-11），直接建卡，不要追问具体日期",
  academic_paper: "整理学术论文：标题、作者、来源、DOI、摘要",
  photo_gallery: "展示多张相互独立的照片",
  weekly_schedule: "一周内或某天具体几点做什么的安排",
  todo_list: "一系列需要勾选完成的任务",
  project_roadmap: "多阶段、有里程碑的长期项目规划",
  data_visualization: "用户给出的数值的趋势、分布或统计",
  news_summary: "摘要一篇新闻或资讯（需有原文或链接）。publishedAt仅指原文明示的发布日期；事件发生日、今天/now不是发布日期。未提供发布日期必须省略publishedAt，不需为此追问；事件日期保留在正文摘要中",
  historical_timeline: "回顾过去的重要事件，按时间顺序",
  quote_note: "记录一句话、金句、感悟或灵感",
  photo_story: "多张照片按顺序讲一个故事",
  activity_feed: "按时间持续新增的活动记录/最近动态",
  goal_progress: "某个明确目标的完成比例",
  habit_tracking: "记录每天是否坚持某个重复行为。可选weeklyGoal为1到7整数，仅在用户明确给出每周目标天数时填写；只是说每天打卡或列出打卡日时省略，不从示例复制4或自行设目标。可选startDate也必须有依据",
  book_record: "管理单本书的阅读状态与进度。author是单个字符串，不是论文authors数组；姓名原样摘取，不加译名。可选rating为1到5整数，未给评分就省略；coverUrl和notes也仅使用用户信息",
  monthly_calendar: "整个月里事项的日期分布",
  option_comparison: "比较多个候选方案。options名称须原样摘取：原话A/B/C就写A/B/C，不自行加前缀变成方案A/方案B；values严格按options顺序逐列对应，chosen若提供必须与某个名称完全一致",
  web_bookmark: "收藏网页、网站、GitHub 仓库或在线资源",
  photo_memory: "纪念或展示单张照片",
  single_notification: "保存用户交付的一条事件通知或状态，例如包裹已送达、构建完成、会议变更。用户以‘通知：’提交具体内容时，应生成通知卡保留正文和编号，不能只回复收到。没有时间安排的事件通知不同于‘提醒我…’；询问通知是什么意思、引用示例或明确不要建卡时仍只回答",
};

/** Prompt notation never becomes a literal JSON key accepted by the parser. */
const dataGuide = (scene: (typeof SCENES)[number]["id"]): string => {
  const optional = [...DATA[scene].matchAll(/"([^"?]+)\?":/g)].map(match => match[1]);
  return `data结构=${DATA[scene].replace(/\?"\s*:/g, '":')}。可选字段（含嵌套字段）：${optional.length ? optional.join("、") : "无"}`;
};

export const buildScenePrompt = (): string => `
场景卡片（重点）：用户想把内容整理、记录、展示成卡片时，优先输出 {"cards":[{"scene_id":"表内固定分类名","data":{…}}],"spokenText":"40字内说明"}，省略冗余card_type。scene_id是固定分类名，不是实例id；同类的多张卡也用相同scene_id，绝不加日期、时间戳或随机编号。若填写card_type，必须是表中箭头右侧的精确类型，不能填左侧场景名。程序负责实例id、布局、时间戳、校验和渲染；禁止输出 HTML、JSX、组件名、样式或卡片模板之外的字段。
下面是结构说明，不是可以照抄的内容：真实键名不带问号；空串占位要换成有意义的文字，必填标题不能空。可选字段无来源时直接省略，不用空串、null、默认数字或今天补齐。数字是类型示例，只能填写本次用户给出的数值。带竖线的枚举必须选择其中一个实际值，不能整串输出。
${SCENES.map(scene => `${scene.id} → ${scene.cardType}：${INTENT[scene.id]}。${dataGuide(scene.id)}`).join("\n")}
合法最小结构示例（只说明结构，不是本次事实）：照片墙 {"cards":[{"scene_id":"photo_gallery","data":{"title":"照片墙","images":[{"url":"https://example.com/user-provided.jpg"}]}}]}（URL须在本次输入中）；查看当前画布动态 {"cards":[{"scene_id":"activity_feed","data":{"title":"最近动态","live":true}}]}；读书记录的author例如"某位作者"，绝不能写["某位作者"]。不要从这些示例复制标题以外的事实。
选择规则：按真实意图和数据结构选，不按关键词。含日期不等于倒计时；「今天有什么要完成」=todo_list；「今天几点做什么」「下周安排」=weekly_schedule；「这个月哪些天有事」=monthly_calendar；「未来三个月怎么推进」=project_roadmap；「今年目标完成多少」=goal_progress；「最近每天有没有打卡」=habit_tracking；「上个月发生了什么重要事件」=historical_timeline；「最近产生了什么活动」=activity_feed（无用户记录时 {"live":true} 显示画布自身动态）；「收藏这篇论文」只有明确是学术论文才用 academic_paper；「收藏这个网站/仓库」=web_bookmark。带时间的“提醒我…”、纯计时器仍按原提醒/倒计时动作，不用场景卡片；便笺原文记录仍用 NoteCard。
用户明确指定卡片形式且数据兼容时服从；不兼容就 clarify。一个请求涉及多个独立对象可输出多张卡（最多 6 张），每张只对应一个场景。意图不明确时 clarify，不要随机选卡；普通聊天、解释、建议用 reply，不强行建卡。
不得编造：数字、日期、时间、年份、星期、链接、DOI、作者、出处、书名、图片只能来自用户原话、clarification、已有画布或 page（用户给的链接正文）。「还有 25 天」「N 天后」「下周三」「月底」等相对说法本身就给出了日期，按 today 推算填入，不要再追问；缺少必要信息先用这些上下文补齐，既没有日期也没有相对天数时才 clarify，只问缺的那一项。照片只用用户给出的 https 链接，没有就省略（用户可在用户页添加照片）。摘要与要点只能依据用户提供的原文或 page，没有原文不要写新闻、论文摘要或历史事件。日期按 today 与 timeZone 计算。`;
