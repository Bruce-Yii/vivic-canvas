import { answerContract } from "./answer.js";
import { countdownContract } from "./countdown.js";
import { noteContract } from "./note.js";
import { todoContract } from "./todo.js";
import { focusContract, highlightContract, overviewContract, restoreContract, undoContract } from "./views.js";
import type { BuiltinCardContract } from "./types.js";

export const CARD_CONTRACTS: Readonly<Record<string, BuiltinCardContract>> = Object.freeze({
  countdown: countdownContract,
  todo: todoContract,
  note: noteContract,
  answer: answerContract,
  overview: overviewContract,
  restore: restoreContract,
  focus: focusContract,
  highlight: highlightContract,
  undo: undoContract,
});

export const getCardContract = (id: string): BuiltinCardContract | undefined =>
  Object.hasOwn(CARD_CONTRACTS, id) ? CARD_CONTRACTS[id] : undefined;
