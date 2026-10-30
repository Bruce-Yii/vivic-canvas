import type { z } from "zod";
import type { Action } from "./actionEnvelope";
import type { HostOperation } from "./decisionTask";

/** A data contract: the model supplies slots; trusted host code builds records. */
export interface CardContract<S, C = unknown> {
  id: string;
  name: string;
  description: string;
  examples: string[];
  cardType: string;
  slots: z.ZodType<S>;
  parse?(text: string, context: C): S | null;
  build(slots: S, context: C, now: Date): CardContractOutput | Promise<CardContractOutput>;
}
export type CardContractOutput = Action[] | { hostOperation: HostOperation };
