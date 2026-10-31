import { zhToNumber } from "./zhNumber";

/** Only a complete answer to a live question may use its frozen numbering. */
export const choiceNumber = (text: string): number | null => {
  const match = text.trim().match(/^(?:(?:选|选择|就|要)\s*)?(?:第\s*)?([零一二两三四五六七八九十百\d]+)\s*(?:号(?:卡片|卡|提醒)?|个|张|条)?[。！!]?$/u);
  return match ? zhToNumber(match[1]!) : null;
};
