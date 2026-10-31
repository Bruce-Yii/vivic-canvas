/**
 * Model Platform Settings Component
 * 
 * Independent UI for configuring the user's own model API provider.
 * Supports preset platforms and custom URLs, with automatic model discovery.
 * 
 * Integration: This component is standalone and not yet wired into ControlApp.
 * The decision-layer window will integrate it into the settings page.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  disconnectPlatform,
  getPlatformStatus,
  validatePlatformConnection,
} from "./api";
import { MODEL_PLATFORM_PRESETS, type PlatformStatus } from "./types";

export interface ModelPlatformSettingsProps {
  /** Disable all interactions (e.g., when backend is offline) */
  disabled?: boolean;
  /** Called when connection state changes */
  onConnectionChange?: (connected: boolean) => void;
}

export const ModelPlatformSettings = ({
  disabled = false,
  onConnectionChange,
}: ModelPlatformSettingsProps) => {
  const [status, setStatus] = useState<PlatformStatus>({
    connected: false,
  });
  const [selectedPreset, setSelectedPreset] = useState<string>("custom");
  const [customUrl, setCustomUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refresh platform status
  const refresh = useCallback(async () => {
    const newStatus = await getPlatformStatus();
    setStatus(newStatus);
    onConnectionChange?.(newStatus.connected);
  }, [onConnectionChange]);

  // Auto-refresh on mount and periodically
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleConnect = async () => {
    const key = apiKey.trim();
    if (!key || busy) return;

    setBusy(true);
    setError(null);

    try {
      const result = await validatePlatformConnection(key);
      if (!result.ok) {
        setError(result.error ?? "连接测试失败");
      } else {
        // Clear key input on success
        setApiKey("");
      }
    } catch (err) {
      setError("连接请求失败");
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const handleDisconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      await disconnectPlatform();
    } catch {
      setError("断开连接失败");
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const currentPreset = MODEL_PLATFORM_PRESETS.find(
    (p) => p.id === selectedPreset,
  );
  const effectiveUrl =
    selectedPreset === "custom" ? customUrl : currentPreset?.baseUrl ?? "";

  const linkState = status.connected ? "已连接" : "未连接";
  const canConnect = !disabled && !busy && !status.connected && apiKey.trim();
  const canDisconnect = !disabled && !busy && status.connected;

  return (
    <section
      className="rounded-xl border border-neutral-200 bg-white p-4"
      data-testid="model-platform-settings"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">模型平台连接</h2>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              status.connected
                ? "bg-emerald-100 text-emerald-800"
                : "bg-neutral-200 text-neutral-700"
            }`}
            data-testid="platform-status-badge"
          >
            {linkState}
          </span>
        </div>

        <div className="space-y-3">
          <div>
            <label
              htmlFor="platform-preset"
              className="block text-xs font-medium text-neutral-700"
            >
              选择平台
            </label>
            <select
              id="platform-preset"
              value={selectedPreset}
              onChange={(e) => setSelectedPreset(e.target.value)}
              disabled={disabled || busy || status.connected}
              className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-500"
              data-testid="platform-preset-select"
            >
              {MODEL_PLATFORM_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            {currentPreset?.description && (
              <p className="mt-1 text-xs text-neutral-500">
                {currentPreset.description}
              </p>
            )}
          </div>

          {selectedPreset === "custom" && (
            <div>
              <label
                htmlFor="platform-url"
                className="block text-xs font-medium text-neutral-700"
              >
                API 基础地址
              </label>
              <Input
                id="platform-url"
                type="url"
                placeholder="https://api.example.com/v1"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                disabled={disabled || busy || status.connected}
                className="mt-1"
                data-testid="platform-url-input"
              />
              <p className="mt-1 text-xs text-neutral-500">
                支持 OpenAI 兼容接口的平台地址
              </p>
            </div>
          )}

          {effectiveUrl && (
            <div className="rounded-md bg-neutral-50 px-3 py-2">
              <p className="text-xs text-neutral-600">
                <span className="font-medium">当前地址：</span>
                <span className="font-mono">{effectiveUrl}</span>
              </p>
            </div>
          )}

          <div>
            <label
              htmlFor="platform-api-key"
              className="block text-xs font-medium text-neutral-700"
            >
              API Key
            </label>
            <div className="mt-1 flex gap-2">
              <Input
                id="platform-api-key"
                type="password"
                autoComplete="off"
                placeholder="输入平台 API Key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={disabled || busy || status.connected}
                className="flex-1"
                data-testid="platform-api-key-input"
              />
              <Button
                onClick={handleConnect}
                disabled={!canConnect}
                data-testid="platform-connect-button"
              >
                {busy ? "验证中…" : "连接"}
              </Button>
            </div>
          </div>

          {(error || status.lastError) && (
            <p
              className="text-xs text-red-600"
              role="status"
              data-testid="platform-error"
            >
              {error || status.lastError}
            </p>
          )}

          {status.connected && (
            <>
              <p className="text-xs text-neutral-600">
                平台连接已验证。Key 仅保存在本地服务内存，断开即清除。
              </p>
              <Button
                variant="secondary"
                onClick={handleDisconnect}
                disabled={!canDisconnect}
                data-testid="platform-disconnect-button"
              >
                断开连接
              </Button>
            </>
          )}
        </div>

        <div className="border-t border-neutral-200 pt-3">
          <p className="text-xs text-neutral-500">
            模型平台用于自定义推理服务，支持 OpenAI 兼容接口。配置后可在对话中使用你自己的模型。
          </p>
        </div>
      </div>
    </section>
  );
};
