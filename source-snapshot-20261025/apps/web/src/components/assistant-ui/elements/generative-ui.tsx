"use client";

import ReactMarkdown from "react-markdown";
import { lazy, Suspense } from "react";
import remarkGfm from "remark-gfm";
import type { GenerativeUILibrary } from "@assistant-ui/generative-ui/react";
import { defaultGenerativeUILibrary } from "@assistant-ui/generative-ui/react";
import { GeoMap, type GeoMapPlace } from "./geo-map";
const MermaidDiagram = lazy(() => import("./mermaid-diagram").then(module => ({ default: module.MermaidDiagram })));

const markdownBase = defaultGenerativeUILibrary.Markdown!;

const pinsOf = (places: unknown): GeoMapPlace[] =>
  (Array.isArray(places) ? places : []).flatMap((place: unknown, index) => {
    if (place === null || typeof place !== "object") return [];
    const { label, lat, lng, detail } = place as Record<string, unknown>;
    return typeof label === "string" &&
      typeof lat === "number" &&
      typeof lng === "number"
      ? [
          {
            id: String(index),
            label,
            lat,
            lng,
            description: typeof detail === "string" ? detail : undefined,
          },
        ]
      : [];
  });

/** `MarkdownTextPrimitive` cannot be reused here: it reads from message-part context, not a prop string. */
export const styledGenerativeUILibrary: GenerativeUILibrary = {
  ...defaultGenerativeUILibrary,
  Markdown: {
    properties: markdownBase.properties,
    streamProperties: markdownBase.streamProperties,
    description: "A markdown string, rendered with GitHub-flavored markdown.",
    render: ({ value, children }) => (
      <div data-aui="markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{value ?? ""}</ReactMarkdown>
        {children}
      </div>
    ),
  },
  Diagram: {
    ...defaultGenerativeUILibrary.Diagram!,
    render: ({ code, title }) => (
      <figure data-aui="diagram">
        <Suspense fallback={<div role="status" className="p-4 text-sm text-muted-foreground">正在加载图表…</div>}>
          <MermaidDiagram code={typeof code === "string" ? code : ""} />
        </Suspense>
        {typeof title === "string" || typeof title === "number" ? (
          <figcaption data-aui="diagram-title">{title}</figcaption>
        ) : null}
      </figure>
    ),
  },
  Map: {
    ...defaultGenerativeUILibrary.Map!,
    render: ({ places, route }) => {
      const pins = pinsOf(places);
      return (
        <GeoMap
          data-aui="map"
          className="max-w-none [&_[data-slot=geo-map-coordinates]]:hidden"
          places={pins}
          routes={
            route && pins.length > 1
              ? [
                  {
                    id: "route",
                    points: pins.map(({ lat, lng }) => [lat, lng] as const),
                  },
                ]
              : undefined
          }
        />
      );
    },
  },
};
