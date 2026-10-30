import type { CardRecord } from "@/contracts";

export type WeatherCard = Extract<CardRecord, { type: "WeatherCard" }>;
export type TableCard = Extract<CardRecord, { type: "TableCard" }>;
export type ChartCard = Extract<CardRecord, { type: "ChartCard" }>;
export type NoteCard = Extract<CardRecord, { type: "NoteCard" }>;
