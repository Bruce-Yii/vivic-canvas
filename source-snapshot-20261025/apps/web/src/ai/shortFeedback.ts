/** Authored StepFun 温柔女声 clips, generated once and bundled with the product.
 * Exact text only: never substitute a canned success for actual operation output.
 */
const phrases: Readonly<Record<string, string>> = {
  "我看看": "checking", "稍等": "waiting", "好的": "okay",
  "我来帮你整理一下": "organizing", "我来安排一下": "planning",
  "正在处理，请稍等": "working", "已经处理好了": "done",
  "已保存": "saved", "已取消本次请求": "cancelled", "已撤销": "undone",
  "准备好了": "ready", "连接成功": "connected", "连接已断开": "disconnected",
  "刚才没有成功，请再试一次": "retry", "你想调整哪一张卡片": "clarify", "这里还没有卡片": "empty",
};
export const feedbackPhrase = (text: string, voice = "wenrounvsheng") =>
  voice === "wenrounvsheng" && Object.hasOwn(phrases, text)
    ? { url: `/voice-feedback/stepfun/${phrases[text]}.mp3` } : null;
