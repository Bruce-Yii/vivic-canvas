import type { CardRecord } from "@/contracts";

const now = () => new Date().toISOString();

const base = (id: string, width = 264, height = 128) => ({
  id,
  variant: "minimal" as const,
  sources: [],
  layout: { x: 0, y: 0, width, height, pinned: false },
  metadata: { createdAt: now(), updatedAt: now() },
});

export const demoCountdownCard = (minutes = 10): CardRecord => ({
  ...base("demo-countdown", 264, 96),
  type: "CountdownCard",
  displayProps: {},
  sourceData: {
    targetAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    startedAt: now(),
  },
});

export const demoTodoCard = (): CardRecord => ({
  ...base("demo-todo", 288, 160),
  type: "TodoCard",
  displayProps: {
    items: [
      { id: "demo-t1", text: "Review wake transition frames", done: true },
      { id: "demo-t2", text: "Capture light + dark screenshots", done: false },
      { id: "demo-t3", text: "Run the FPS sampler", done: false },
    ],
  },
  sourceData: {},
});

export const demoSearchCard = (): CardRecord => ({
  ...base("demo-search", 296, 148),
  type: "SearchResultCard",
  displayProps: {
    title: "Motion — animation library for JS",
    summary:
      "Production-ready declarative animations for the web used by Vivic.",
    // VISUAL PROTOTYPE ONLY — demo content, explicitly labeled.
    sourceLabel: "DEMO · motion.dev",
  },
  sourceData: { note: "static demo content" },
  sources: [
    {
      title: "Motion",
      url: "https://motion.dev/",
      fetchedAt: now(),
      provider: "demo-static",
      readFullPage: false,
    },
  ],
});

export const demoCards = (): CardRecord[] => [
  demoCountdownCard(),
  demoTodoCard(),
  demoSearchCard(),
];
