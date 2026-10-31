import { validateInstance, type CardDefinition, type CardExample, type JsonObject } from "@vivic/card-runtime";
import { createCanvasStore, type CanvasStore } from "@/state/canvasStore";
import type { CardOfType } from "@/contracts";
import { createExtensionInstance } from "./extensionInstance";

/** Owns only the same in-memory reducer as the app. No owner, DB, broadcast or service connection. */
export class TestSpaceSession {
  readonly token = crypto.randomUUID();
  readonly store: CanvasStore = createCanvasStore();
  private generation = 0;
  private closed = false;
  private testedRevision: number | null = null;
  readonly definition: CardDefinition;
  constructor(definition: CardDefinition) { this.definition = definition; this.loadExample(definition.examples[0]!); }
  get card(): CardOfType<"ExtensionCard"> {
    const card = this.store.getState().cards[0]?.record;
    if (!card || card.type !== "ExtensionCard") throw new Error("预览已关闭");
    return card;
  }
  get canInstall() { return !this.closed && this.testedRevision === this.generation; }
  private replace(example: Pick<CardExample, "config" | "data" | "state">) {
    if (this.closed) throw new Error("预览已关闭");
    this.generation++; this.testedRevision = null;
    const card = createExtensionInstance(this.definition, example);
    this.store.reset();
    // The preview uses the pure reducer in loadState. Owner-side runtime checks still apply to real actions.
    const result = this.store.dispatch({ schemaVersion: "0.6", requestId: `${this.token}:${this.generation}`, canvasId: `test:${this.token}`, actions: [{ type: "card.create", card }] });
    if (!result.ok) throw new Error(result.error);
  }
  loadExample(example: CardExample) { this.replace(example); }
  setConfig(config: JsonObject) { const { data, state } = this.card.displayProps; this.replace({ config, data, state }); }
  setState(state: JsonObject) { const { data, config } = this.card.displayProps; this.replace({ config, data, state }); }
  async run(): Promise<boolean> {
    const generation = this.generation, card = this.card;
    validateInstance(this.definition, card.displayProps);
    await Promise.resolve();
    if (this.closed || generation !== this.generation) return false;
    this.testedRevision = generation; return true;
  }
  cancel() { this.generation++; this.testedRevision = null; }
  close() { this.closed = true; this.cancel(); this.store.reset(); }
}
