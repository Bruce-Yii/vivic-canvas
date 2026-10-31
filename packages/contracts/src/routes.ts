/** Shared route descriptions; the model selects a capability, never a CardRecord. */
export const ROUTES = {
  chat: "闲聊、打招呼、感谢、情绪表达，不需要做任何事",
  answer: "知识问答、解释、介绍，或解释某句话、某张卡的意思（被解释的命令不执行）",
  search: "需要联网查询的实时信息，如天气、新闻、价格、最新资料",
  countdown: "新建一个倒计时、计时器，或在一段时间后提醒（不是暂停或修改已有的）",
  todo: "新建待办事项或任务清单",
  note: "把用户说的内容记下来、记笔记、做便签",
  generate: "帮用户写作、整理、规划、总结、改写，或生成表格图表",
  focus: "聚焦、放大、打开查看某一张已有卡片",
  overview: "显示全部卡片，把所有卡片放进一屏的全局视图",
  restore: "退出聚焦，恢复之前的视图",
  highlight: "让某张卡片或卡片里的某一条闪烁高亮，方便找到",
  edit: "修改已有卡片：勾选完成、增删条目、改标题、展开收起、暂停或继续倒计时",
  arrange: "移动、固定或取消固定、整理卡片布局，或把卡片传送到用户页/展示页",
  delete: "删除卡片或清空画布",
  undo: "撤销或重做刚才的操作",
  unsupported: "系统做不到的事，如下单购物、打电话、转账、控制家电",
} as const;

export type IntentRouteId = keyof typeof ROUTES;
