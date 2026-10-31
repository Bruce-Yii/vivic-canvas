import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CardDefinition } from "@vivic/card-runtime";
import { HostedDefinitionContext } from "@/extensions/HostedDefinitionScope";
import { hostedRequest } from "./client";

const RefreshContext = createContext<() => void>(() => {});
export const useRefreshHostedDefinitions = () => useContext(RefreshContext);
const referenceKey = (reference: { id: string; version: string; hash: string }) => JSON.stringify([reference.id, reference.version, reference.hash]);
interface DefinitionState { loading: boolean; definitions: Map<string, CardDefinition>; error?: string }
/** The caller keys this provider to both account and Space. No legacy browser
 * package is consulted or installed into IndexedDB by this server scope. */
export function HostedDefinitions({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [revision, setRevision] = useState(0), [state, setState] = useState<DefinitionState>(() => ({ loading: enabled, definitions: new Map() }));
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!enabled) { setState({ loading: false, definitions: new Map() }); return; }
    const controller = new AbortController(); setState({ loading: true, definitions: new Map() });
    void (async () => {
      const [{ revalidateDefinition, definitionKey, definitionRef }, response] = await Promise.all([import("@vivic/card-runtime"), hostedRequest<{ definitions: unknown[] }>("/api/space/definitions", undefined, "GET", controller.signal)]);
      if (!Array.isArray(response.definitions) || response.definitions.length > 256 || new TextEncoder().encode(JSON.stringify(response)).byteLength > 8 * 1024 * 1024) throw new Error("definitions-limit");
      const definitions = new Map<string, CardDefinition>(); let invalid = false;
      for (const raw of response.definitions) {
        controller.signal.throwIfAborted();
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("definition" in raw) || !("key" in raw) || !("enabled" in raw) || typeof raw.enabled !== "boolean" || new TextEncoder().encode(JSON.stringify(raw)).byteLength > 2 * 1024 * 1024) { invalid = true; continue; }
        try { const definition = await revalidateDefinition(raw.definition), reference = definitionRef(definition);
          if (raw.key !== definitionKey(reference)) { invalid = true; continue; }
          if (raw.enabled) definitions.set(referenceKey(reference), definition);
        } catch { invalid = true; }
      }
      if (!controller.signal.aborted) setState({ loading: false, definitions, ...(invalid ? { error: "部分空间卡片定义未通过校验，原始卡片数据已保留。" } : {}) });
    })().catch(() => { if (!controller.signal.aborted) setState({ loading: false, definitions: new Map(), error: "空间卡片定义暂不可用，请重新检查连接；不会读取此浏览器的旧卡片包。" }); });
    return () => controller.abort();
  }, [enabled, revision]);
  const scope = useMemo(() => ({ loading: state.loading, error: state.error, get: (reference: { id: string; version: string; hash: string }) => state.definitions.get(referenceKey(reference)) }), [state]);
  return <RefreshContext value={refresh}><HostedDefinitionContext value={scope}>{children}</HostedDefinitionContext></RefreshContext>;
}
