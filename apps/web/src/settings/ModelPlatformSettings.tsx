/**
 * Model-platform settings panel.
 *
 * A self-contained settings surface for the user's own model provider:
 * pick a preset (or type a custom base URL), enter a key, then pull the model
 * list from the platform instead of typing a model name by hand. Every field
 * stays editable, and a connection test performs a real inference rather than
 * trusting a health endpoint.
 *
 * Rendered standalone; the Control page mounts it (see README.md).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createProvider, deleteProvider, fetchPresets, fetchProviders,
  previewModels, previewTest, testProvider,
} from "./api";
import {
  ERROR_TYPE_LABEL, FALLBACK_PRESETS, ROLE_LABEL, filterModels, pickDefaultChatModel,
  type DraftProvider, type ModelInfo, type ProviderPreset, type ProviderProtocol,
  type ProviderRole, type ProviderStatus, type TestResult,
} from "./types";

export interface ModelPlatformSettingsProps {
  /** Disables every control (e.g. while the backend is offline). */
  disabled?: boolean;
  /** Notified whenever the saved-provider connection state changes. */
  onConnectionChange?: (connected: boolean) => void;
}

const PROTOCOLS: Array<{ value: ProviderProtocol; label: string }> = [
  { value: "openai-compatible", label: "OpenAI 兼容（chat/completions）" },
  { value: "stepfun-v1", label: "StepFun 普通 API（/v1）" },
  { value: "stepfun-plan", label: "StepFun Plan（/step_plan/v1）" },
  { value: "startlux-native", label: "StartLux 原生（4B：state/questions）" },
  { value: "legacy-2b", label: "旧版适配器（2B：input/labels）" },
];

const ROLES: ProviderRole[] = ["main", "decision", "asr", "tts", "embedding"];

interface FormState {
  presetId: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  apiKey: string;
  model: string;
  roles: ProviderRole[];
}

const EMPTY_FORM: FormState = {
  presetId: "custom",
  name: "",
  baseUrl: "",
  protocol: "openai-compatible",
  apiKey: "",
  model: "",
  roles: ["main"],
};

const formForPreset = (preset: ProviderPreset | undefined): FormState => {
  if (!preset) return EMPTY_FORM;
  return {
    presetId: preset.id,
    name: preset.name,
    baseUrl: preset.baseUrl,
    protocol: preset.protocol,
    apiKey: "",
    model: preset.defaultModel ?? "",
    roles: preset.roles ?? ["main"],
  };
};

const toDraft = (form: FormState): DraftProvider => ({
  presetId: form.presetId,
  name: form.name.trim() || undefined,
  protocol: form.protocol,
  baseUrl: form.baseUrl.trim(),
  ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
  ...(form.model.trim() ? { model: form.model.trim() } : {}),
  roles: form.roles,
});

export const ModelPlatformSettings = ({
  disabled = false,
  onConnectionChange,
}: ModelPlatformSettingsProps) => {
  const [presets, setPresets] = useState<ProviderPreset[]>([...FALLBACK_PRESETS]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelFallback, setModelFallback] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [modelListOpen, setModelListOpen] = useState(false);
  const [busy, setBusy] = useState<"models" | "test" | "save" | "row" | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mounted = useRef(true);

  // React StrictMode mounts, unmounts and re-mounts effects in development.
  // The flag must be restored on mount, otherwise every state update after an
  // await is silently skipped and the panel looks frozen.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await fetchProviders();
      if (!mounted.current) return;
      setProviders(list);
      setLoadError(null);
      onConnectionChange?.(list.some((provider) => provider.connected));
    } catch {
      if (!mounted.current) return;
      setLoadError("无法读取已保存的模型平台，请确认本地服务在运行。");
    }
  }, [onConnectionChange]);

  useEffect(() => {
    void refresh();
    void fetchPresets()
      .then((list) => { if (mounted.current && list.length) setPresets(list); })
      .catch(() => undefined);
  }, [refresh]);

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === form.presetId),
    [presets, form.presetId],
  );

  // Start from the first preset so the panel is usable immediately: the user
  // only has to paste a key, never a URL or a model name.
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || presets.length === 0) return;
    initialized.current = true;
    setForm((current) => (current.baseUrl.trim() ? current : formForPreset(presets[0])));
  }, [presets]);

  const filteredModels = useMemo(() => filterModels(models, modelQuery), [models, modelQuery]);

  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

  const selectPreset = (presetId: string) => {
    const preset = presets.find((candidate) => candidate.id === presetId);
    setForm(formForPreset(preset));
    setModels([]);
    setModelQuery("");
    setModelListOpen(false);
    setTestResult(null);
    setError(null);
    setNote(null);
    setModelFallback(false);
  };

  const handleFetchModels = async () => {
    if (disabled || busy) return;
    if (!form.baseUrl.trim()) { setError("请先填写 Base URL。"); return; }
    setBusy("models");
    setError(null);
    setNote(null);
    setTestResult(null);
    try {
      const result = await previewModels(toDraft(form));
      if (!mounted.current) return;
      if (!result.ok || !result.models?.length) {
        setModels([]);
        setError(result.error ?? "该平台没有返回可用模型。");
        return;
      }
      setModels(result.models);
      setModelFallback(Boolean(result.fallback));
      setModelListOpen(true);
      setNote(result.note ?? (result.fallback ? "该平台没有 /models 端点，已使用内置模型清单。" : null));
      // Never leave the user with an empty model name.
      if (!form.model.trim()) {
        const preferred = pickDefaultChatModel(result.models);
        if (preferred) update({ model: preferred });
      }
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : "获取模型失败。");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const handleTest = async () => {
    if (disabled || busy) return;
    if (!form.model.trim()) { setError("请先选择或填写模型名。"); return; }
    setBusy("test");
    setError(null);
    try {
      const result = await previewTest(toDraft(form));
      if (!mounted.current) return;
      setTestResult(result);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : "测试连接失败。");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const handleSave = async () => {
    if (disabled || busy) return;
    if (!form.name.trim()) { setError("请填写平台名称。"); return; }
    if (!form.baseUrl.trim()) { setError("请先填写 Base URL。"); return; }
    if (!form.model.trim()) { setError("请先获取并选择模型。"); return; }
    setBusy("save");
    setError(null);
    try {
      const result = await createProvider(toDraft(form));
      if (!mounted.current) return;
      if (!result.ok) { setError(result.error ?? "保存失败。"); return; }
      setForm(EMPTY_FORM);
      setModels([]);
      setModelQuery("");
      setTestResult(null);
      setNote(null);
      setModelFallback(false);
      await refresh();
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : "保存失败。");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const handleRowTest = async (provider: ProviderStatus) => {
    if (disabled || busy) return;
    setBusy("row");
    try {
      const result = await testProvider(provider.id);
      if (!mounted.current) return;
      await refresh();
      if (!result.ok) setError(`${provider.name}：${result.error ?? "测试失败"}`);
      else setNote(`${provider.name}：${result.latencyMs ?? "?"} ms，${result.models ?? 0} 个模型`);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : "测试失败。");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const handleRowDelete = async (provider: ProviderStatus) => {
    if (disabled || busy) return;
    setBusy("row");
    try {
      await deleteProvider(provider.id);
      if (!mounted.current) return;
      await refresh();
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : "删除失败。");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const toggleRole = (role: ProviderRole) => {
    setForm((current) => ({
      ...current,
      roles: current.roles.includes(role)
        ? current.roles.filter((entry) => entry !== role)
        : [...current.roles, role],
    }));
  };

  const pending = busy !== null;

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4" data-testid="model-platform-settings">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">模型平台</h2>
        <span className="text-xs text-neutral-500">自带模型服务（BYO）</span>
      </div>

      {loadError && (
        <p className="mt-2 text-xs text-amber-700" role="status" data-testid="provider-load-error">{loadError}</p>
      )}

      {/* ---- Configure a provider ---- */}
      <div className="mt-3 space-y-3">
        <div>
          <label htmlFor="provider-preset" className="block text-xs font-medium text-neutral-700">平台预设</label>
          <select
            id="provider-preset"
            value={form.presetId}
            onChange={(event) => selectPreset(event.target.value)}
            disabled={disabled || pending}
            className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm disabled:bg-neutral-50"
            data-testid="provider-preset-select"
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.name}</option>
            ))}
          </select>
          {selectedPreset?.description && (
            <p className="mt-1 text-xs text-neutral-500" data-testid="provider-preset-description">
              {selectedPreset.description}
            </p>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="provider-name" className="block text-xs font-medium text-neutral-700">名称</label>
            <Input id="provider-name" value={form.name} disabled={disabled || pending}
              onChange={(event) => update({ name: event.target.value })}
              placeholder="我的模型平台" className="mt-1" data-testid="provider-name-input" />
          </div>
          <div>
            <label htmlFor="provider-protocol" className="block text-xs font-medium text-neutral-700">协议</label>
            <select id="provider-protocol" value={form.protocol}
              onChange={(event) => update({ protocol: event.target.value as ProviderProtocol })}
              disabled={disabled || pending}
              className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm disabled:bg-neutral-50"
              data-testid="provider-protocol-select">
              {PROTOCOLS.map((protocol) => (
                <option key={protocol.value} value={protocol.value}>{protocol.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="provider-url" className="block text-xs font-medium text-neutral-700">Base URL</label>
          <Input id="provider-url" value={form.baseUrl} disabled={disabled || pending}
            onChange={(event) => update({ baseUrl: event.target.value })}
            placeholder="https://api.example.com/v1" className="mt-1" data-testid="provider-url-input" />
        </div>

        <div>
          <label htmlFor="provider-key" className="block text-xs font-medium text-neutral-700">
            API Key{selectedPreset?.auth === "none" ? "（该平台通常无需 Key）" : ""}
          </label>
          <Input id="provider-key" type="password" autoComplete="off" value={form.apiKey}
            disabled={disabled || pending}
            onChange={(event) => update({ apiKey: event.target.value })}
            placeholder="仅发送到本机后端，不落盘浏览器" className="mt-1" data-testid="provider-key-input" />
        </div>

        {/* ---- Model discovery ---- */}
        <div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label htmlFor="provider-model" className="block text-xs font-medium text-neutral-700">模型</label>
              <Input id="provider-model" value={form.model} disabled={disabled || pending}
                onChange={(event) => update({ model: event.target.value })}
                placeholder="点右侧「获取模型」，或直接填写" className="mt-1" data-testid="provider-model-input" />
            </div>
            <Button type="button" variant="secondary" onClick={() => void handleFetchModels()}
              disabled={disabled || pending || !form.baseUrl.trim()} data-testid="provider-fetch-models">
              {busy === "models" ? "获取中…" : "获取模型"}
            </Button>
          </div>

          {models.length > 0 && (
            <div className="mt-2 rounded-md border border-neutral-200" data-testid="provider-model-picker">
              <div className="flex items-center gap-2 border-b border-neutral-200 p-2">
                <Input value={modelQuery} disabled={disabled || pending}
                  onChange={(event) => { setModelQuery(event.target.value); setModelListOpen(true); }}
                  onFocus={() => setModelListOpen(true)}
                  placeholder={`搜索模型（共 ${models.length} 个）`} aria-label="搜索模型"
                  data-testid="provider-model-search" />
                <Button type="button" variant="ghost" onClick={() => setModelListOpen((open) => !open)}
                  data-testid="provider-model-toggle">
                  {modelListOpen ? "收起" : "展开"}
                </Button>
              </div>
              {modelListOpen && (
                <ul className="max-h-48 overflow-y-auto p-1" role="listbox" data-testid="provider-model-list">
                  {filteredModels.length === 0 && (
                    <li className="px-2 py-1 text-xs text-neutral-500" data-testid="provider-model-empty">没有匹配的模型</li>
                  )}
                  {filteredModels.map((model) => (
                    <li key={model.id}>
                      <button type="button" role="option" aria-selected={form.model === model.id}
                        onClick={() => { update({ model: model.id }); setModelListOpen(false); }}
                        disabled={disabled || pending}
                        className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-neutral-100 ${form.model === model.id ? "bg-neutral-100 font-medium" : ""}`}
                        data-testid="provider-model-option" data-model-id={model.id}>
                        <span className="truncate font-mono">{model.id}</span>
                        <span className="ml-2 shrink-0 text-neutral-500">{model.kind}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {modelFallback && (
                <p className="border-t border-neutral-200 px-2 py-1 text-xs text-neutral-500" data-testid="provider-model-fallback">
                  该平台没有 /models 端点，已使用内置模型清单。
                </p>
              )}
            </div>
          )}
        </div>

        {/* ---- Roles ---- */}
        <fieldset>
          <legend className="text-xs font-medium text-neutral-700">用途（可多选）</legend>
          <div className="mt-1 flex flex-wrap gap-3" data-testid="provider-roles">
            {ROLES.map((role) => (
              <label key={role} className="flex items-center gap-1 text-xs text-neutral-700">
                <input type="checkbox" className="h-3.5 w-3.5 accent-neutral-900"
                  checked={form.roles.includes(role)} disabled={disabled || pending}
                  onChange={() => toggleRole(role)} data-testid={`provider-role-${role}`} />
                {ROLE_LABEL[role]}
              </label>
            ))}
          </div>
        </fieldset>

        {/* ---- Actions ---- */}
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void handleTest()}
            disabled={disabled || pending || !form.model.trim()} data-testid="provider-test">
            {busy === "test" ? "测试中…" : "测试连接"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => void handleSave()}
            disabled={disabled || pending || !form.name.trim() || !form.baseUrl.trim() || !form.model.trim()}
            data-testid="provider-save">
            {busy === "save" ? "保存中…" : "保存"}
          </Button>
        </div>

        {error && (
          <p className="text-xs text-red-600" role="status" data-testid="provider-error">{error}</p>
        )}
        {note && !error && (
          <p className="text-xs text-neutral-600" role="status" data-testid="provider-note">{note}</p>
        )}

        {testResult && (
          <div className={`rounded-md px-3 py-2 text-xs ${testResult.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}
            role="status" data-testid="provider-test-result" data-ok={testResult.ok}>
            {testResult.ok ? (
              <>
                连接成功 · {testResult.latencyMs ?? "?"} ms · 模型 {testResult.model}
                {testResult.models !== undefined ? ` · 平台共 ${testResult.models} 个模型` : ""}
              </>
            ) : (
              <>
                {testResult.errorType ? `[${ERROR_TYPE_LABEL[testResult.errorType]}] ` : ""}
                {testResult.error ?? "连接失败"}
              </>
            )}
          </div>
        )}
      </div>

      {/* ---- Saved providers ---- */}
      <div className="mt-4 border-t border-neutral-200 pt-3">
        <h3 className="text-xs font-semibold text-neutral-700">已保存的模型平台</h3>
        {providers.length === 0 ? (
          <p className="mt-1 text-xs text-neutral-500" data-testid="provider-list-empty">
            还没有保存的模型平台。选择一个预设，填入 Key，获取模型后保存即可。
          </p>
        ) : (
          <ul className="mt-2 space-y-2" data-testid="provider-list">
            {providers.map((provider) => (
              <li key={provider.id} className="rounded-md border border-neutral-200 p-2"
                data-testid="provider-row" data-provider-id={provider.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">{provider.name}</p>
                    <p className="truncate text-xs text-neutral-500">
                      {provider.protocol} · {provider.baseUrl}
                      {provider.model ? ` · ${provider.model}` : ""}
                    </p>
                    <p className="text-xs text-neutral-500">
                      用途：{provider.roles.map((role) => ROLE_LABEL[role]).join("、") || "未指定"}
                      {provider.hasApiKey ? ` · Key ${provider.apiKeyHint ?? "已保存"}` : " · 无 Key"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${provider.connected ? "bg-emerald-100 text-emerald-800" : "bg-neutral-200 text-neutral-700"}`}
                      data-testid="provider-status-badge" data-connected={provider.connected}>
                      {provider.connected ? `已连接 · ${provider.latencyMs ?? "?"} ms` : "未连接"}
                    </span>
                    <Button type="button" variant="secondary" size="sm" disabled={disabled || pending}
                      onClick={() => void handleRowTest(provider)} data-testid="provider-row-test">
                      测试
                    </Button>
                    <Button type="button" variant="ghost" size="sm" disabled={disabled || pending}
                      onClick={() => void handleRowDelete(provider)} data-testid="provider-row-delete">
                      删除
                    </Button>
                  </div>
                </div>
                {provider.lastError && !provider.connected && (
                  <p className="mt-1 text-xs text-red-600" data-testid="provider-row-error">
                    {provider.errorType ? `[${ERROR_TYPE_LABEL[provider.errorType]}] ` : ""}
                    {provider.lastError}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-3 text-xs text-neutral-500">
        Key 只保存在本机后端（加密存储），不会写进浏览器、日志或仓库；清空并保存即可移除。
        未配置任何平台时，行为与原先完全一致。
      </p>
    </section>
  );
};
