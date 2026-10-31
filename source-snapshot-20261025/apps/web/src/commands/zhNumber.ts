const ZH_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 十 / 二十 / 二十五 / 半 / Arabic digits (and decimals) up to 99. */
export const zhToNumber = (text: string): number | null => {
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (text === "半") return 0.5;
  if (!/^[零一二两三四五六七八九十]+$/.test(text)) return null;
  const tenIdx = text.indexOf("十");
  if (tenIdx === -1) {
    return text.length === 1 ? (ZH_DIGIT[text] ?? null) : null;
  }
  const tens =
    tenIdx === 0 ? 1 : text.length <= 3 ? (ZH_DIGIT[text[0]!] ?? null) : null;
  if (tens === null) return null;
  const rest = text.slice(tenIdx + 1);
  const ones = rest === "" ? 0 : rest.length === 1 ? (ZH_DIGIT[rest] ?? null) : null;
  if (ones === null) return null;
  return tens * 10 + ones;
};
