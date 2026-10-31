import { NoteCardSchema } from "@vivic/contracts";
import { newId } from "@/lib/id";
import type { ConnectionResult } from "./api";

export function connectionResultCard(result: ConnectionResult) {
  const now = new Date().toISOString();
  return NoteCardSchema.parse({ id: newId("connected-source"), type: "NoteCard", variant: "standard",
    displayProps: { text: `${result.title}\n${result.text}`.slice(0, 500) },
    sourceData: { connectedSource: { provider: result.provider, tool: result.tool, title: result.title, checkedAt: result.checkedAt,
      text: result.text.slice(0, 24000), truncated: result.truncated || result.text.length > 24000, previewTruncated: result.text.length > 500, links: result.links.slice(0, 15) } },
    sources: [{ title: result.title.slice(0, 500), kind: "service", fetchedAt: result.checkedAt, provider: result.source.slice(0, 80), readFullPage: false },
      ...result.links.slice(0, 14).map(link => ({ title: link.title.slice(0, 500), url: link.url, fetchedAt: result.checkedAt, provider: result.source.slice(0, 80), readFullPage: false }))],
    layout: { x: 0, y: 0, width: 320, height: 210, pinned: false, surface: "display" }, metadata: { createdAt: now, updatedAt: now, aliases: [result.title.slice(0, 80)] },
  });
}
