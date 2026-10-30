import { Component, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { CARD_TYPE_LABELS, type CardRecord } from "@/contracts";

/** One card failing to render must never blank the canvas or the user page. */
export class CardErrorBoundary extends Component<{ card: CardRecord; children: ReactNode }, { failedFor: string | null }> {
  state = { failedFor: null as string | null };

  static getDerivedStateFromError() {
    return { failedFor: "pending" };
  }

  componentDidCatch() {
    // Remember which revision failed so a later valid update renders again.
    this.setState({ failedFor: this.revision() });
  }

  componentDidUpdate() {
    const { failedFor } = this.state;
    if (failedFor && failedFor !== "pending" && failedFor !== this.revision()) this.setState({ failedFor: null });
  }

  private revision() {
    return `${this.props.card.id}:${this.props.card.metadata.updatedAt}`;
  }

  render() {
    if (!this.state.failedFor) return this.props.children;
    return <div className="vivic-scene-fallback" role="status" data-card-render-error={this.props.card.type}>
      <span className="inline-flex items-center gap-1.5 font-medium"><TriangleAlert size={14} aria-hidden />这张{CARD_TYPE_LABELS[this.props.card.type] ?? "卡片"}暂时无法显示</span>
      <span>数据已保留；可在控制端查看或删除后重新生成。</span>
    </div>;
  }
}
