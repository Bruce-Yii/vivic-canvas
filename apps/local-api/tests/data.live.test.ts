import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDataClient } from "../src/data/index.js";
import { emptyContext } from "./helpers.js";

// Explicit opt-in. No auth, local server, browser, credential store or speech.
describe.skipIf(process.env.VIVIC_DATA_LIVE !== "1")("Open-Meteo live data evidence", () => {
  it("records a real qualified-city current-weather envelope or an explicit failure", async () => {
    const client = createDataClient({ config: { timeoutMs: 20_000 } });
    const text = "上海,上海市天气";
    const started = Date.now();
    const result = await client.handleDataIntent(text, emptyContext());
    const record = { at: new Date().toISOString(), text, elapsedMs: Date.now() - started,
      outcome: result?.kind === "envelope" ? "WEATHER_RESPONSE" : "BLOCKED", result };
    const directory = fileURLToPath(new URL("../../../evidence/data-providers/", import.meta.url));
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/open-meteo-live.json`, `${JSON.stringify(record, null, 2)}\n`);
    console.info(JSON.stringify({ diagnostic: "open-meteo-no-key", outcome: record.outcome, elapsedMs: record.elapsedMs }));
    expect(result?.kind).toBe("envelope");
    const action = result?.envelope?.actions.find(action => action.type === "card.create");
    expect(action?.type === "card.create" ? action.card : null).toMatchObject({ type: "WeatherCard", sources: [
      { provider: "open-meteo/geocoding" }, { provider: "open-meteo/forecast" },
    ], sourceData: { currentConditionsBasis: "weather-model", location: { name: "上海", admin1: "上海市" } } });
  }, 25_000);
});
