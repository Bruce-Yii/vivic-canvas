import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getProvidersStatus, validateStepfunKey, type ProvidersStatusResponse } from "@/ai/api";
import { selectLlmProvider } from "@/ai/providers";

export type OnlineConnection =
  | { phase: "idle" | "checking" | "connecting" | "disconnected" | "offline" }
  | { phase: "connected"; provider: "stepfun" | "gpt"; model?: string }
  | { phase: "error"; message: string };

function fromStatus(data: ProvidersStatusResponse): OnlineConnection {
  const provider = data.providers.find(item => item.name === (data.activeProvider ?? "stepfun"));
  return provider?.connected
    ? { phase: "connected", provider: provider.name, model: provider.defaultModel?.slice(0, 100) }
    : { phase: "disconnected" };
}

/** Keys live only in the current input/request. UI cancellation never claims to
 * undo a server-side connection that may already have completed. */
export function useOnlineConnection(enabled: boolean) {
  const [connection, setConnection] = useState<OnlineConnection>({ phase: "idle" });
  const [keyInput, setKeyInput] = useState("");
  const lifecycle = useRef({ revision: 0, running: false, alive: true, enabled: false });

  const invalidate = useCallback(() => {
    const scope = lifecycle.current;
    scope.revision++;
    scope.running = false;
    setKeyInput("");
  }, []);

  const current = useCallback((id: number) => {
    const scope = lifecycle.current;
    return scope.alive && scope.enabled && scope.revision === id;
  }, []);

  const refresh = useCallback(async () => {
    const scope = lifecycle.current;
    if (!scope.enabled || scope.running) return;
    const id = ++scope.revision;
    scope.running = true;
    setConnection({ phase: "checking" });
    try {
      const data = await getProvidersStatus();
      if (current(id)) setConnection(fromStatus(data));
    } catch {
      if (current(id)) setConnection({ phase: "offline" });
    } finally {
      if (current(id)) scope.running = false;
    }
  }, [current]);

  useEffect(() => {
    const scope = lifecycle.current;
    scope.alive = true;
    return () => { scope.alive = false; scope.revision++; scope.running = false; };
  }, []);

  useLayoutEffect(() => {
    const scope = lifecycle.current;
    scope.enabled = enabled;
    // Starts external connection synchronization on entry; loading is visible.
    // oxlint-disable-next-line react/set-state-in-effect
    if (enabled) void refresh();
    // Security boundary: owner disable/unmount must clear an abandoned key.
    // oxlint-disable-next-line react/set-state-in-effect
    else invalidate();
    return () => { scope.enabled = false; scope.revision++; scope.running = false; };
  }, [enabled, invalidate, refresh]);

  const connect = async () => {
    const scope = lifecycle.current;
    const key = keyInput.trim();
    if (!scope.enabled || scope.running || !key) return;
    const id = ++scope.revision;
    scope.running = true;
    // Clear before the await, including failed, cancelled and abandoned attempts.
    setKeyInput("");
    setConnection({ phase: "connecting" });
    try {
      const result = await validateStepfunKey(key);
      if (!current(id)) return;
      if (!result.ok || !result.connected) {
        setConnection({ phase: "error", message: "连接验证未通过，请检查 Coding Plan Key 后重试。" });
        return;
      }
      const selected = await selectLlmProvider("stepfun");
      if (!current(id)) return;
      if (!selected.ok) {
        setConnection({ phase: "error", message: "连接已验证，但服务切换失败，请重试检查连接。" });
        return;
      }
      const data = await getProvidersStatus();
      if (!current(id)) return;
      const verified = fromStatus(data);
      setConnection(verified.phase === "connected" && verified.provider === "stepfun"
        ? verified : { phase: "error", message: "连接状态尚未确认，请重试检查连接。" });
    } catch {
      if (current(id)) setConnection({ phase: "offline" });
    } finally {
      if (current(id)) scope.running = false;
    }
  };

  return { connection, keyInput, setKeyInput, connect, refresh, invalidate };
}
