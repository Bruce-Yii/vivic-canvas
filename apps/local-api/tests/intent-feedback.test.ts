import { describe, expect, it, vi } from "vitest";
import { feedbackReader, withoutFeedback } from "../src/intent/feedback.js";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import { CredentialStore } from "../src/credentials.js";
import { emptyContext } from "./helpers.js";
import { createApp } from "../src/app.js";
import { authed, testConfig } from "./helpers.js";

describe("same-call feedback metadata", () => {
  it("decodes escaped quotes and unicode across every possible split without exposing slots", () => {
    const content = JSON.stringify({ feedback: '我来整理“阅读”材料。', slots: { text: "内部字段" } });
    for (let cut = 0; cut <= content.length; cut++) {
      const publish = vi.fn(), read = feedbackReader(publish);
      read(content.slice(0, cut)); read(content.slice(cut));
      expect(publish.mock.calls).toEqual([['我来整理“阅读”材料。']]);
    }
    const publish = vi.fn(), read = feedbackReader(publish);
    for (const character of '{"feedback":"我来整理\\u201c阅读\\u201d材料。","slots":{}}') read(character);
    expect(publish).toHaveBeenCalledWith('我来整理“阅读”材料。');
  });
  it.each([
    '{"slots":{},"feedback":"我来整理。"}', '{"feedback":"已创建卡片。"}', '{"feedback":"便笺创建好了，计时也设好了。"}', '{"feedback":"tools.cards.todo({})"}',
    '{"feedback":"我来整理', '{"feedback": {"text":"不能透传"}}', '{"say":"最终文案"}',
    '{"feedback":"card.create targetId=note_123"}', '{"feedback":"我来写入NoteCard的displayProps。"}',
  ])("does not publish unsafe, incomplete or late fields: %s", content => {
    const publish = vi.fn(); feedbackReader(publish)(content); expect(publish).not.toHaveBeenCalled();
  });
  it.each([
    "已为你创建卡片。", "已帮你生成内容。", "我帮你弄好了。", "做好了。", "搞定了。",
    "卡片弄好了，请查看。", "我创建了卡片。", "已删除卡片。", "已设置提醒。",
  ])("rejects a finished-state first sentence even without an adjacent 已: %s", text => {
    const publish = vi.fn(); feedbackReader(publish)(JSON.stringify({ feedback: text })); expect(publish).not.toHaveBeenCalled();
  });
  it.each([
    "正在创建卡片。", "正在为你创建卡片。", "正在整理这张卡。", "我会帮你创建。", "我先看看。", "我来整理一下。",
  ])("keeps an honest in-progress first sentence: %s", text => {
    const publish = vi.fn(); feedbackReader(publish)(JSON.stringify({ feedback: text })); expect(publish).toHaveBeenCalledWith(text);
  });
  it("leaves the existing output contract intact", () => {
    expect(withoutFeedback({ feedback: "我来整理。", slots: { text: "原文" } })).toEqual({ slots: { text: "原文" } });
  });
  it("starts a clean prefix for a provider retry after an incomplete string", () => {
    const publish = vi.fn(), read = feedbackReader(publish);
    read('{"feedback":"我来'); read.reset(); read('{"feedback":"我来整理内容。","slots":{}}');
    expect(publish.mock.calls).toEqual([["我来整理内容。"]]);
  });
  it("publishes during the same generation, preserves final slots and ignores aborted late feedback", async () => {
    const events: unknown[] = [], controller = new AbortController();
    let delta: ((value: string) => void) | undefined;
    const generate = vi.fn(async (_messages, _signal, _maxTokens, onTextDelta) => {
      delta = onTextDelta;
      onTextDelta('{"feedback":"我来整理这份内容。",');
      expect(events).toContainEqual(expect.objectContaining({ feedback: "我来整理这份内容。" }));
      return { ok: true as const, value: { feedback: "我来整理这份内容。", contract: "note", slots: { text: "阅读草稿" }, say: "已生成。" } };
    });
    const deps: PipelineDeps = { slotPlanning: true, streamFeedback: true, credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" },
      planner: { provider: "gpt", connected: true, isCurrent: () => true, generate }, onStage: event => events.push(event) };
    const result = await runIntent({ text: "整理一份阅读草稿", canvasContext: emptyContext() }, deps, controller.signal);
    expect(generate).toHaveBeenCalledOnce(); expect(result.kind).toBe("envelope");
    expect(result.envelope?.actions).toContainEqual(expect.objectContaining({ type: "card.create", card: expect.objectContaining({ type: "NoteCard" }) }));
    controller.abort(); delta?.('{"feedback":"我继续整理。"}');
    expect(events.filter((event: any) => event.feedback)).toHaveLength(1);
  });
  it("delivers the real authenticated SSE feedback before the provider finishes, without logging content", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "test-key-only", models: ["test-model"], defaultModel: "test-model", checkedAt: "test" });
    let finish!: () => void;
    const diagnostics: unknown[] = [];
    const frame = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).stream).toBe(true);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(frame('{"feedback":"我来整理阅读草稿。",')));
        finish = () => {
          controller.enqueue(new TextEncoder().encode(frame('"slots":{"text":"阅读草稿"},"say":"已保存。"}')
            + `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`)); controller.close();
        };
      } }), { headers: { "content-type": "text/event-stream" } });
    });
    const app = createApp({ config: testConfig({ modelApiBaseUrl: "https://unused.test" }), credentials, fetchImpl,
      onDiagnostic: event => diagnostics.push(event), router: { mode: "on", directRoutes: new Set(["note"]),
        routeUtterance: async () => ({ route: "note", probability: .99, probabilities: { note: .99 }, none: false, latencyMs: 0 }), chooseTarget: async () => null } });
    try {
      const response = await app.request("/api/intent", { method: "POST", headers: { ...authed, accept: "text/event-stream" },
        body: JSON.stringify({ text: "整理一份阅读草稿", canvasContext: emptyContext() }) });
      const reader = response.body!.getReader(), decoder = new TextDecoder(); let text = "";
      while (!text.includes('"feedback":"我来整理阅读草稿。"')) text += decoder.decode((await reader.read()).value);
      expect(text).not.toContain("event: result"); expect(fetchImpl).toHaveBeenCalledOnce();
      expect(JSON.stringify(diagnostics)).not.toContain("我来整理阅读草稿");
      finish();
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); }
      expect(text.match(/event: result/g)).toHaveLength(1);
      const final = JSON.parse(text.split("event: result\ndata: ")[1]!.trim());
      expect(final.task.status).toBe("awaiting_execution");
      expect(final.envelope.actions).toContainEqual(expect.objectContaining({ type: "card.create", card: expect.objectContaining({ type: "NoteCard" }) }));
    } finally { app.dispose(); }
  });
  it("keeps ordinary JSON client planning unchanged", async () => {
    const generate = vi.fn(async (messages, _signal, maxTokens, onTextDelta) => {
      expect(onTextDelta).toBeUndefined(); expect(messages[0].content).not.toContain('"feedback"字段');
      // The token cap stays a number: the delta sink is positional after it.
      expect(typeof maxTokens).toBe("number");
      return { ok: true as const, value: { contract: "note", slots: { text: "阅读草稿" } } };
    });
    const result = await runIntent({ text: "整理一份阅读草稿", canvasContext: emptyContext() }, {
      slotPlanning: true, credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" },
      planner: { provider: "gpt", connected: true, isCurrent: () => true, generate } });
    expect(result.kind).toBe("envelope"); expect(generate).toHaveBeenCalledOnce();
  });
});
