/** An explicit new command must not be consumed as an answer to an old question. */
export function startsNewInstruction(text: string, previousUtterance?: string): boolean {
  const value = text.trim();
  if (/^(?:请帮我|帮我|请|给我)?\s*(?:搜索|搜|查|创建|新建|添加|新增|(?:加|列)(?:一?[个张条]|几条|下)?\s*待办|删除|取消|打开|读取|阅读|显示|展示|恢复|撤销|聚焦|放大|高亮|选中|暂停|继续|展开|收起|折叠|重新排|整理|待办(?:事项|列表|卡片|卡)?\s*[:：])/.test(value)) return true;
  if (/提醒我|(?:把|将).*(?:待办|任务).*(?:完成|高亮)|(?:天气|气温)(?:卡片|卡)?(?:怎么样|如何)?[。？！?!]?$/.test(value)) return true;
  // A duration can answer “delete which timer?”. Otherwise it starts a new
  // timer instead of inheriting an unrelated failed weather/plan question.
  return /倒计时[。！!]*$/.test(value) && !/删除|删掉|移除|聚焦|放大|暂停|继续/.test(previousUtterance ?? "");
}
