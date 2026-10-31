import { HostOperationSchema, type HostOperation } from "@vivic/contracts";
import type { ControlHost } from "@/sync/controlHost";
import type { DispatchResult, VivicState } from "@/state/canvasStore";
import { resumeReminderSource } from "@/reminders/reminders";

/** Resolve geometry and clock math against the current owner, never model coordinates. */
export function executeHostOperation(host: ControlHost, state: VivicState, raw: HostOperation, executionId: string, now = Date.now()): DispatchResult {
  const operation = HostOperationSchema.parse(raw), snapshot = host.getSnapshot();
  if (!snapshot.ready || snapshot.ownerMode !== "owner" || !snapshot.activeCanvasId) return { ok: false, error: "控制权已变化" };
  if (operation.kind === "history.undo") return host.undo() ? { ok: true, deduplicated: false } : { ok: false, error: "没有可撤销的操作，或目标内容已变化。" };
  if (operation.kind === "history.redo") return host.redo() ? { ok: true, deduplicated: false } : { ok: false, error: "没有可重做的操作，或目标内容已变化。" };
  if (operation.kind === "ambient.control") return host.setPreferences(operation.mode === "soft" ? { ambientMotion: "subtle", ambientIntensity: 0.3 }
    : operation.mode === "vivid" ? { ambientMotion: "vivid", ambientIntensity: 0.85 } : operation.mode === "off" ? { ambientMotion: "off" }
      : operation.mode === "warm" ? { lightPalette: "peach", darkPalette: "ember" }
        : operation.mode === "cool" ? { lightPalette: "milk", darkPalette: "midnight" } : { ambientMotion: "subtle", ambientIntensity: 0.55 });
  if (operation.kind === "canvas.organize.preview") return { ok: false, error: "整理与分区已暂时关闭。" };
  if (operation.kind === "canvas.arrange") return host.arrangeCanvas();
  const card = state.cards.find(entry => entry.record.id === operation.targetId && !entry.exitingRequestId)?.record;
  if (!card) return { ok: false, error: "目标卡片已不存在" };
  switch (operation.kind) {
    case "card.pin": return host.setCardPinned(card.id, operation.pinned);
    case "card.surface": return host.setCardSurface(card.id, operation.surface);
    case "card.move": {
      if (card.layout.pinned) return { ok: false, error: "卡片已固定，请先解除固定" };
      const surface = card.layout.surface ?? "display";
      const anchor = operation.relativeTo ? state.cards.find(entry => entry.record.id === operation.relativeTo && !entry.exitingRequestId)?.record : card;
      if (!anchor || (anchor.layout.surface ?? "display") !== surface || operation.relativeTo === card.id) return { ok: false, error: "相对目标无效或不在同一页面" };
      const origin = surface === "user" ? anchor.layout.userPos ?? { x: 24, y: 80 } : anchor.layout;
      const gap = 24, horizontal = operation.direction === "left" || operation.direction === "right";
      const sign = operation.direction === "left" || operation.direction === "up" ? -1 : 1;
      const extent = horizontal ? (sign < 0 ? card.layout.width : anchor.layout.width) : (sign < 0 ? card.layout.height : anchor.layout.height);
      let x = origin.x + (horizontal ? sign * (extent + gap) : 0);
      let y = origin.y + (horizontal ? 0 : sign * (extent + gap));
      const others = state.cards.filter(entry => !entry.exitingRequestId && entry.record.id !== card.id && (entry.record.layout.surface ?? "display") === surface);
      for (let slot = 0; slot < 64; slot++) {
        const overlap = others.some(({ record }) => {
          const point = surface === "user" ? record.layout.userPos ?? { x: 24, y: 80 } : record.layout;
          return x < point.x + record.layout.width + gap && x + card.layout.width + gap > point.x && y < point.y + record.layout.height + gap && y + card.layout.height + gap > point.y;
        });
        if (!overlap) return surface === "user" ? host.setCardSurface(card.id, "user", { x, y }) : host.moveCard(card.id, x, y);
        if (horizontal) y += card.layout.height + gap; else x += card.layout.width + gap;
      }
      return { ok: false, error: "附近没有足够空间，请手动调整" };
    }
    case "countdown.pause":
    case "countdown.resume": {
      if (card.type !== "CountdownCard" || card.sourceData.event || card.sourceData.schedule || card.sourceData.condition || card.sourceData.notifiedAt) return { ok: false, error: "此卡片不支持暂停或继续计时" };
      const paused = Boolean(card.sourceData.pausedAt);
      if ((operation.kind === "countdown.pause") === paused) return { ok: false, error: paused ? "计时已暂停" : "计时已经在运行" };
      if (!paused && Date.parse(card.sourceData.targetAt) <= now) return { ok: false, error: "计时已经结束" };
      return host.dispatch({ schemaVersion: "0.6", requestId: executionId, canvasId: snapshot.activeCanvasId,
        actions: [{ type: "card.update", targetId: card.id, sourceData: operation.kind === "countdown.pause" ? { pausedAt: new Date(now).toISOString() } : resumeReminderSource(card, now) }] });
    }
  }
}
