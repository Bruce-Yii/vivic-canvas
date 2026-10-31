import { renderGenerativeUI, type GenerativeUILibrary } from "@assistant-ui/generative-ui/react";
import { z } from "zod";
import { styledGenerativeUILibrary } from "@/components/assistant-ui/elements/generative-ui";

/**
 * Vivic card-internal render library: the installed assistant-ui styled
 * registry, plus strictly-typed local entries for card-only affordances. Every
 * spec node is whitelisted here — no model/unknown component can ever render.
 */
export const vivicGUILibrary: GenerativeUILibrary = {
  ...styledGenerativeUILibrary,
  TodoItem: {
    description: "Single minimal todo row: checkbox state plus text.",
    properties: z.object({
      text: z.string(),
      done: z.boolean(),
      highlighted: z.boolean().optional(),
    }),
    render: ({ text, done, highlighted }) => (
      <span className="min-w-0 max-w-full" data-aui="checkbox" data-vivic-highlighted={highlighted || undefined}>
        <input className="shrink-0" type="checkbox" checked={Boolean(done)} readOnly tabIndex={-1} />
        <span
          data-aui="option-content"
          className={`min-w-0 [overflow-wrap:anywhere] ${done ? "line-through opacity-55" : ""}`}
        >
          {String(text ?? "")}
        </span>
      </span>
    ),
  },
};

export const renderVivicSpec = (spec: unknown) =>
  renderGenerativeUI(spec, vivicGUILibrary);
