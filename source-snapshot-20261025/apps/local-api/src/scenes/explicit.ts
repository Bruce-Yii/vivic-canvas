import type { SceneId } from "@vivic/contracts";

/**
 * When the user names the card form outright ("做成时间线", "用月历展示",
 * "照片墙形式"), that form wins if the data fits. This only recognises the
 * names of card forms — never the topic — so it cannot pick a scene by itself;
 * it only rejects a planner answer that ignored an explicit instruction.
 */
const FORMS: Array<[RegExp, SceneId]> = [
  [/时间线|时间轴/, "historical_timeline"],
  [/月历|日历视图|月视图/, "monthly_calendar"],
  [/周计划|周视图|周日程|周程表/, "weekly_schedule"],
  [/路线图|看板|阶段规划|里程碑卡/, "project_roadmap"],
  [/待办(?:清单|列表)?|任务清单|todo/i, "todo_list"],
  [/折线图|柱状图|条形图|饼图|趋势图|图表/, "data_visualization"],
  [/照片墙|相册|瀑布流/, "photo_gallery"],
  [/轮播|故事卡|图片故事/, "photo_story"],
  [/封面|纪念卡/, "photo_memory"],
  [/进度环|环形进度|进度圈/, "goal_progress"],
  [/热力图|打卡(?:卡片|日历|表)/, "habit_tracking"],
  [/对比(?:卡|表)|比较(?:卡|表)|对比表格/, "option_comparison"],
  [/便笺卡|金句卡|语录卡|灵感卡/, "quote_note"],
  [/书籍卡|读书卡|书卡/, "book_record"],
  [/文献卡|论文卡/, "academic_paper"],
  [/新闻卡|资讯卡/, "news_summary"],
  [/链接卡|网页卡|书签卡|收藏卡/, "web_bookmark"],
  [/通知卡/, "single_notification"],
  [/动态(?:卡|流)|活动流/, "activity_feed"],
  [/倒计时卡|倒数日/, "countdown"],
];

const VERB = "(?:用|做成|生成|变成|改成|换成|以|按|弄成|整理成|展示成|显示成|画成|画个|做个|做一个|来个|来一个|建一个|给我一个|创建|放进|放到)";

export function explicitScene(text: string): SceneId | null {
  const value = text.normalize("NFKC");
  for (const [form, scene] of FORMS) {
    const source = form.source;
    const asInstruction = new RegExp(`${VERB}\\s*(?:一?[张个份幅])?\\s*(?:${source})`, form.flags);
    const asForm = new RegExp(`(?:${source})\\s*(?:卡片|卡|形式|样式|视图|的形式|来展示|展示|呈现)`, form.flags);
    if (asInstruction.test(value) || asForm.test(value)) return scene;
  }
  return null;
}
