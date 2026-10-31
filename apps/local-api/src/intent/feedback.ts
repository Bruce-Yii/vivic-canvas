/** The first JSON field is an optional, provisional sentence. Final say/text
 * and all slots still follow the existing validation/commit path. */
export const FEEDBACK_PROMPT = '\n在上述JSON最前面增加"feedback"字段：先用一句80字以内的自然中文说明你正在怎样处理本次请求，然后继续输出原有完整JSON。feedback只能表达当前意图，不得说已经创建、保存、完成或执行成功，不得包含JSON、契约名、工具参数或推理；say/text仍是原有最终结果字段。反馈不能代替任何业务字段：保留用户给定的各项事实及其对应关系，时间表述没有专用字段时保留在对应事项正文，不补造具体钟点。';

/** Emit only a fully decoded first-field string, never raw JSON fragments.
 * Other field orders simply have no early feedback. Limit retained prefix. */
export function feedbackReader(publish: (text: string) => void): ((delta: string) => void) & { reset(): void } {
  let prefix = "", finished = false;
  const read = (delta: string) => {
    if (finished) return;
    prefix += delta;
    if (prefix.length > 2048) { finished = true; return; }
    const head = /^\s*\{\s*"((?:\\.|[^"\\])*)"\s*:/.exec(prefix);
    if (!head) return;
    if (head[1] !== "feedback") { finished = true; return; }
    const rest = prefix.slice(head[0].length);
    const string = /^\s*("(?:\\.|[^"\\])*")/.exec(rest);
    if (!string) { if (/^\s*[^"\s]/.test(rest)) finished = true; return; }
    finished = true;
    let text: string;
    try { text = JSON.parse(string[1]!) as string; } catch { return; }
    text = text.trim();
    if (!text || Array.from(text).length > 80 || /[{}\[\]`<>\r\n]|(?:tools?\.|card\.|canvas\.|stage\.|slots|contract|sourceData|displayProps|targetId|itemId|requestId|metadata|reasoning|[A-Z][a-z]+Card)|已(?:经|完成|保存|创建|生成|执行|记下|设置)|完成了|成功|(?:创建|生成|设置|设|保存|记下|处理|整理|固定|删除).{0,8}好了|(?:(?:saved|created|completed|done)\b)/i.test(text)) return;
    try { publish(text); } catch { /* observation never changes a proposal */ }
  };
  return Object.assign(read, { reset() { prefix = ""; finished = false; } });
}

/** Feedback is transport metadata, never business data or a new output contract. */
export function withoutFeedback<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "feedback")) return value;
  const { feedback: _feedback, ...output } = value as Record<string, unknown>;
  return output as T;
}
