// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardSnapshot } from "@vivic/mobile-console-prototype/protocol";
import { MobileCardPreview } from "./MobileCardPreview";
import { readCountdownPreview, countdownPreviewValue } from "./countdownPreview";

const targetAt = "2026-10-23T10:02:00.000Z", now = Date.parse("2026-10-23T10:00:00.000Z");
const timer = (body = `到期：${targetAt}`, title = "倒计时", value = "02:00"): CardSnapshot => ({ id:"timer", type:"CountdownCard", title, pinned:false, preview:{ kind:"metric", stat:{value}, body } });
let host:HTMLDivElement, root:Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); vi.setSystemTime(now); host=document.createElement("div"); document.body.append(host); root=createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = async (card:CardSnapshot) => act(async () => root.render(<MobileCardPreview card={card} />));
it("does not render a Word extract from an older paired computer", async () => {
  await render({ id: "legacy", type: "FileCard", title: "old.docx", pinned: false,
    file: { name: "old.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: 10, sha256: "a".repeat(64), parseStatus: "ready" },
    preview: { kind: "text", body: "OLD WORD EXTRACT" } });
  expect(host.textContent).toContain("此格式仅保留原文件下载");
  expect(host.textContent).not.toContain("OLD WORD EXTRACT");
});

describe("compatible mobile countdown summaries", () => {
  it("shows only ticking digits for the owner's exact plain timer summary", async () => {
    await render(timer()); expect(host.textContent).toBe("02:00"); expect(host.querySelector("h2")).toBeNull();
    await act(async () => vi.advanceTimersByTime(1000)); expect(host.textContent).toBe("01:59");
    await act(async () => vi.advanceTimersByTime(120000)); expect(host.textContent).toBe("00:00");
  });
  it("shows the full reminder and time while keeping paused/conditional values fixed", async () => {
    await render(timer(`检查烤箱 · 到期：${targetAt}`, "检查烤箱"));
    expect(host.querySelector("h2")?.textContent).toBe("检查烤箱"); expect(host.textContent).not.toContain("到期");
    await render(timer(`检查烤箱 · 已暂停 · 到期：${targetAt}`, "检查烤箱", "01:20"));
    await act(async () => vi.advanceTimersByTime(2000)); expect(host.textContent).toBe("检查烤箱01:20");
    await render(timer(`检查烤箱 · 到期：${targetAt}`, "检查烤箱", "等待"));
    await act(async () => vi.advanceTimersByTime(2000)); expect(host.textContent).toBe("检查烤箱等待");
  });
  it.each([timer("到期：2026-02-31T10:00:00Z"), timer("到期：下周"), timer("到期：2026-10-23"), timer(`说明 · 到期：${targetAt}`), { ...timer(), type:"NotificationCard" }, { ...timer(), preview:{kind:"text" as const, body:"旧快照的完整说明"} }])("leaves nonmatching or invalid old summaries untouched", async card => {
    expect(readCountdownPreview(card)).toBeNull(); await render(card); expect(host.textContent).toContain(card.preview!.body);
  });
  it("recognizes offsets without normalizing or inventing a missing date", () => {
    const projected = readCountdownPreview(timer("到期：2026-10-23T18:02:00+08:00"))!;
    expect(countdownPreviewValue(projected,now)).toBe("02:00");
  });
});
describe("read-only mobile content", () => {
  it("explains empty lists and does not expose editable controls", async () => {
    await render({id:"empty",type:"TodoCard",title:"今天",pinned:false,preview:{kind:"checklist",items:[]}});
    expect(host.textContent).toContain("暂无待办事项"); expect(host.querySelector("input,textarea,select,button")).toBeNull();
  });
  it("renders untrusted strings as text and preserves a summary-only extension", async () => {
    await render({id:"x",type:"NoteCard",title:"便笺",pinned:false,preview:{kind:"text",body:"<img src=x onerror=alert(1)>"}});
    expect(host.querySelector("img")).toBeNull(); expect(host.textContent).toContain("<img src=x");
    await render({id:"extension",type:"ExtensionCard",title:"扩展卡片",pinned:false});
    expect(host.textContent).toContain("请在电脑端查看"); expect(host.querySelector("input,textarea,select,button")).toBeNull();
  });
});
