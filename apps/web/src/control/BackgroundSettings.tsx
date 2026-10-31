import { useState, useSyncExternalStore } from "react";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { ATMOSPHERE_PALETTES, DARK_PALETTE_IDS, LIGHT_PALETTE_IDS, paletteFor, type PaletteId } from "@/components/atmosphere/palettes";
import type { ControlHost } from "@/sync/controlHost";
import type { DisplayPreferences } from "@/sync/protocol";
import { ORB_PALETTE_IDS, ORB_PALETTES, orbPalette } from "@/stage/orbPalette";
import { ambientMode, type AmbientMotion } from "@/motion/spaceMotion";

/**
 * Control-only sky/light preferences. Composited Hark sky avoids a GPU context;
 * choosing a palette also selects its appearance so the change is visible at
 * once on Display, the user page and here. "自动" keeps both choices.
 */
export const BackgroundSettings = ({ host, disabled = false, resolvedTheme, compact = false }: { host: ControlHost; disabled?: boolean; resolvedTheme: "light" | "dark"; compact?: boolean }) => {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const readonly = disabled || !snapshot.ready || snapshot.ownerMode !== "owner";
  const preferences = snapshot.preferences;
  const motionMode = ambientMode(preferences.ambientMotion);
  const light = <details className="se-details" data-vivic-light-settings>
    <summary><span>空间光效</span><span className="se-background-current">{motionMode === "off" ? "已暂停" : motionMode === "vivid" ? "灵动" : "柔和"}<HarkIcon name="chevron-down" /></span></summary>
    <div className="se-detail-body">
      <div className="flex flex-wrap gap-2" role="group" aria-label="空间动效">
        {([['off', '暂停'], ['subtle', '柔和'], ['vivid', '灵动']] as const).map(([value, label]) => <button key={value} type="button" disabled={readonly}
          className="vivic-chip se-motion-choice" aria-pressed={motionMode === value} data-vivic-motion-mode={value}
          onClick={() => { const result = host.setPreferences({ ambientMotion: value as AmbientMotion }); setError(result.ok ? null : "动效尚未保存，请重试。"); }}>
          <span className="se-motion-preview" aria-hidden="true"><i /></span>{label}{motionMode === value && <HarkIcon name="check" size={14} />}
        </button>)}
      </div>
      {preferences.reducedMotion && <p className="text-xs opacity-60">已启用减少动效，背景保持静止。</p>}
    </div>
  </details>;
  const ball = <details className="se-details" data-vivic-orb-settings>
    <summary><span>Vivic 球</span><span className="se-background-current"><span className="se-swatch" style={{ background: orbPalette(preferences.orbPalette).swatch }} />{orbPalette(preferences.orbPalette).name}<HarkIcon name="chevron-down" /></span></summary>
    <div className="se-detail-body flex flex-wrap gap-2" role="group" aria-label="Vivic 球配色">
      {ORB_PALETTE_IDS.map(id => <button key={id} type="button" disabled={readonly}
        className="vivic-chip" aria-pressed={(preferences.orbPalette ?? "aurora") === id} data-vivic-orb-palette={id}
        onClick={() => { const result = host.setPreferences({ orbPalette: id }); setError(result.ok ? null : "配色尚未保存，请重试。"); }}>
        <span className="se-swatch" aria-hidden="true" style={{ background: ORB_PALETTES[id].swatch }} />{ORB_PALETTES[id].name}
        {(preferences.orbPalette ?? "aurora") === id && <HarkIcon name="check" size={14} />}
      </button>)}
    </div>
  </details>;
  const shown = paletteFor(resolvedTheme, preferences);
  const choose = (family: "dark" | "light", id: PaletteId) => {
    const patch: Partial<DisplayPreferences> = family === "dark"
      ? { theme: preferences.theme === "auto" && resolvedTheme === "dark" ? "auto" : "dark", darkPalette: id as DisplayPreferences["darkPalette"] }
      : { theme: preferences.theme === "auto" && resolvedTheme === "light" ? "auto" : "light", lightPalette: id as DisplayPreferences["lightPalette"] };
    const result = host.setPreferences(patch);
    setError(result.ok ? null : "配色尚未保存，请重试。");
  };
  const group = (family: "dark" | "light", label: string, ids: readonly PaletteId[]) => {
    const chosen = paletteFor(family, preferences);
    return <div role="group" aria-label={`${label}配色`}>
      <p className="text-xs font-medium text-neutral-600">{label}</p>
      <div className="se-palette-row">
        {ids.map(id => {
          const palette = ATMOSPHERE_PALETTES[id];
          const selected = chosen === id;
          return <button key={id} type="button" disabled={readonly} aria-pressed={selected}
            onClick={() => choose(family, id)} data-vivic-palette={id} data-vivic-palette-shown={shown === id ? "true" : undefined}
            className="se-palette-option" aria-label={`${label} · ${palette.name}`} title={palette.name}>
            <span aria-hidden="true" className="se-palette-circle"
              style={{ background: `conic-gradient(${palette.swatch[0]} 0 30%, ${palette.swatch[1]} 30% 65%, ${palette.swatch[2]} 65% 100%)` }} />
          </button>;
        })}
      </div>
    </div>;
  };
  if (compact) return <section className="se-background" data-vivic-background-settings>
    <details className="se-details"><summary><span>背景</span><span className="se-background-current">
      <span className="se-swatch" style={{ background: `conic-gradient(${ATMOSPHERE_PALETTES[shown].swatch.join(",")})` }} />
      {ATMOSPHERE_PALETTES[shown].name}<HarkIcon name="chevron-down" /></span></summary>
      <div className="se-detail-body">{group("light", "浅色", LIGHT_PALETTE_IDS)}{group("dark", "深色", DARK_PALETTE_IDS)}</div>
    </details>
    {ball}
    {light}
    {error && <p className="se-error" role="status">{error}</p>}
  </section>;
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4" data-vivic-background-settings>
      <h2 className="text-sm font-semibold">背景配色</h2>
      <p className="mt-1 text-xs text-neutral-500">
        展示窗口、聊天页和设置页共用天空背景。选择配色会切换到对应的深色或浅色，并为天空添加轻柔叠色；主题设为「自动」时，白天用所选浅色、夜间用所选深色。
      </p>
      <fieldset disabled={readonly} className="mt-3 space-y-4">
        {group("dark", "深色", DARK_PALETTE_IDS)}
        {group("light", "浅色", LIGHT_PALETTE_IDS)}
      </fieldset>
      <p className="mt-3 text-xs text-neutral-500" data-vivic-palette-current>当前显示：{ATMOSPHERE_PALETTES[shown].name}（{resolvedTheme === "dark" ? "深色" : "浅色"}）</p>
      {ball}
      {light}
      {error && <p role="status" className="mt-2 text-xs text-red-700">{error}</p>}
    </section>
  );
};
