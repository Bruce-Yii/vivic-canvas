/** A same-tab launcher template becomes an editable draft, never an automatic command. */
const key = "vivic.pending-template.v1";
export function prepareTemplateDraft(text: string) {
  try { sessionStorage.setItem(key, JSON.stringify({ text: text.slice(0, 2000), at: Date.now() })); } catch { /* The canvas remains reachable without preference storage. */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("vivic:template-draft", { detail: text.slice(0, 2000) }));
}
export function readTemplateDraft(): string {
  try {
    const raw = sessionStorage.getItem(key);
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string" || !("at" in value) || typeof value.at !== "number" || Date.now()-value.at>300000 || value.at>Date.now()+5000) return "";
    return value.text.slice(0,2000);
  } catch { return ""; }
}
export function consumeTemplateDraft(text: string) {
  try { if (readTemplateDraft() === text) sessionStorage.removeItem(key); } catch { /* Public draft only. */ }
}
