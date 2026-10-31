import { decisionConnectionLabel, decisionConnectionState, isDecisionModelConnected, type DecisionConnectionStatus, type DecisionModelId } from "./decisionModelStatus";

export interface HostedDecisionProbe {
  model: DecisionModelId;
  choice: string | null;
  score: number;
  needs_review: boolean;
}

export interface DecisionModelSettingsProps {
  models: { configured: boolean; decision?: DecisionConnectionStatus } | null;
  selectedModel: DecisionModelId;
  input: string;
  result: HostedDecisionProbe | null;
  busy: boolean;
  onModelChange(model: DecisionModelId): void;
  onInputChange(input: string): void;
  onConnect(): void;
  onDisconnect(): void;
  onClassify(): void;
}

const modelNames: Record<DecisionModelId, string> = {
  "startlux-decision-2b": "Startlux Decision 2B",
  "gliner2.5-multi-decide": "GLiNER 2.5 Multi Decide",
};

const choiceNames: Record<string, string> = {
  fit: "在一屏显示全部卡片", restore: "恢复之前的画布视图", focus: "聚焦一张卡片", delete: "删除卡片",
  expand: "展开便笺并查看全文", collapse: "收起便笺只显示摘要", other: "不明确或其他要求",
};

export function DecisionModelSettings({ models, selectedModel, input, result, busy, onModelChange, onInputChange,
  onConnect, onDisconnect, onClassify }: DecisionModelSettingsProps) {
  const connected = isDecisionModelConnected(models?.configured, models?.decision, selectedModel);
  const connectionState = decisionConnectionState(models?.configured, models?.decision, selectedModel);
  const label = decisionConnectionLabel(models?.configured, models?.decision, selectedModel);
  return <div className="hosted-decision-settings">
    <div className="hosted-setting-row">
      <span>决策模型连接</span>
      <span className="hosted-model-status" data-state={connectionState} role="status">
        <i aria-hidden="true" />{label}
      </span>
    </div>
    <form className="hosted-form hosted-decision-form" onSubmit={event => { event.preventDefault(); onConnect(); }}>
      <label htmlFor="hosted-decision-model">决策模型
        <select id="hosted-decision-model" value={selectedModel} onChange={event => onModelChange(event.target.value as DecisionModelId)}>
          <option value="startlux-decision-2b">{modelNames["startlux-decision-2b"]}</option>
          <option value="gliner2.5-multi-decide">{modelNames["gliner2.5-multi-decide"]}</option>
        </select>
      </label>
      <div className="hosted-decision-actions">
        <button type="submit" className="hosted-primary" disabled={busy || !models?.configured}>
          {connected ? "重新测试并连接" : "连接并测试"}
        </button>
        <button type="button" className="hosted-quiet" disabled={busy || !models?.decision?.configured} onClick={onDisconnect}>断开决策模型</button>
      </div>
    </form>
    <p className="hosted-muted">使用上方已连接的平台 Key。连接会先执行一次分类探测；分类质量仍待验收，卡片执行已关闭。</p>
    <form className="hosted-form hosted-decision-form" onSubmit={event => { event.preventDefault(); onClassify(); }}>
      <label htmlFor="hosted-decision-input">分类测试语句
        <input id="hosted-decision-input" value={input} maxLength={2000} onChange={event => onInputChange(event.target.value)} placeholder="输入一条要分类的指令" />
      </label>
      <button type="submit" className="hosted-quiet hosted-decision-test" disabled={busy || !connected || input.trim().length < 2}>测试分类</button>
    </form>
    {result && <p className="hosted-decision-result" role="status">
      <span>分类结果：{result.choice ? choiceNames[result.choice] ?? result.choice : "未得出明确分类"}</span>
      <span>模型分数 {result.score.toFixed(3)} · {result.needs_review ? "需要人工复核" : "无需复核"}</span>
    </p>}
  </div>;
}
