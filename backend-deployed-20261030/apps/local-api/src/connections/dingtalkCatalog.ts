/** Reviewed official DWS read RPCs, not name heuristics or remote safety claims.
 * Source: DingTalk-Real-AI/dingtalk-workspace-cli@52f38a4a6997da07fd9159fa643d313ca9b83409
 * internal/helpers/doc.go: searchCmd, listCmd, infoCmd, readCmd (Effect:read/Risk:low).
 * Parameter subset omits protected-document password and keeps only read selectors.
 */
const text = { type: "string", minLength: 1, maxLength: 1024 };
const strings = { type: "array", items: text, maxItems: 20 };
const page = { type: "integer", minimum: 1, maximum: 50 };
const timestamp = { type: "integer", minimum: 0 };
const catalog: Record<string, { properties: Record<string, Record<string, unknown>>; required: string[] }> = {
  search_documents: { properties: { keyword: text, extensions: strings, createdTimeFrom: timestamp, createdTimeTo: timestamp,
    visitedTimeFrom: timestamp, visitedTimeTo: timestamp, creatorUserIds: strings, editorUserIds: strings, mentionedUserIds: strings,
    workspaceIds: strings, pageSize: page, pageToken: text }, required: [] },
  list_nodes: { properties: { folderId: text, workspaceId: text, pageSize: page, pageToken: text }, required: [] },
  get_document_info: { properties: { nodeId: text }, required: ["nodeId"] },
  get_document_content: { properties: { nodeId: text, format: { type: "string", enum: ["markdown", "jsonml"] },
    historyVersion: timestamp, scope: { type: "string", enum: ["full", "outline", "range", "section", "tags"] },
    tags: text, maxDepth: { type: "integer", minimum: 0, maximum: 12 }, startBlockId: text, endBlockId: text }, required: ["nodeId"] },
};
export const DINGTALK_READ_TOOLS = Object.freeze(Object.keys(catalog));

/** Any new tool/selector needs a source review. Remote schemas cannot introduce actions. */
export function reviewedDingtalkSchema(name: string, remote: Record<string, unknown>): Record<string, unknown> | undefined {
  const known = catalog[name];
  if (!known || remote.type !== "object" || !remote.properties || typeof remote.properties !== "object" || Array.isArray(remote.properties)
    || remote.$ref || remote.anyOf || remote.oneOf || remote.allOf) return undefined;
  const required = Array.isArray(remote.required) ? remote.required : [];
  const properties: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(remote.properties)) {
    // Official optional access-password support is intentionally not exposed by this client.
    if (name === "get_document_content" && key === "password" && !required.includes(key)) continue;
    const reviewed = known.properties[key];
    if (!reviewed || !raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const rule = raw as Record<string, unknown>;
    if (rule.$ref || rule.anyOf || rule.oneOf || rule.allOf || (rule.type !== reviewed.type && !(reviewed.type === "integer" && rule.type === "number"))) return undefined;
    if (reviewed.type === "array" && (!(rule.items && typeof rule.items === "object") || (rule.items as { type?: unknown }).type !== "string")) return undefined;
    properties[key] = reviewed;
  }
  if (known.required.some(key => !Object.hasOwn(properties, key)) || required.some(key => typeof key !== "string" || !Object.hasOwn(properties, key))) return undefined;
  return { type: "object", properties, required: [...new Set([...known.required, ...required as string[]])], additionalProperties: false };
}
