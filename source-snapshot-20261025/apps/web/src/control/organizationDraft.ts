import { OrganizeOptionsSchema, type OrganizeOptions } from "@/state/organizeCards";
let draft: { canvasId: string; options: OrganizeOptions } | null = null;
export const requestOrganizationPreview = (canvasId: string, options: OrganizeOptions) => {
  draft = { canvasId, options: OrganizeOptionsSchema.parse(options) };
  window.dispatchEvent(new Event("vivic:organize-preview"));
};
export const readOrganizationDraft = (canvasId: string | null) => draft?.canvasId === canvasId ? draft.options : null;
export const clearOrganizationDraft = () => { draft = null; };
