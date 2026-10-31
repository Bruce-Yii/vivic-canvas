import { i as interop } from './rolldown-runtime-Dd_uD5pT.js';
import { t as reactModule } from './react-CQOZoUwg.js';
import { t as palettes, i as paletteForTheme } from './palettes-y4eFPjSE.js';

const React = interop(reactModule(), 1);
const h = React.createElement;
const effects = [
  ['glow', '柔光雾面'], ['aurora', '顶部极光'], ['silk', '丝绸流光'],
  ['liquid', '液态流光'], ['none', '纯净背景']
];
const hex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const clamp = (value, min, max, fallback) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export function presetCustomColors(theme, palette) {
  const colors = palettes[palette].colors;
  return { [theme === 'dark' ? 'customDarkColors' : 'customLightColors']:
    { enabled: false, base: colors[0], glow1: colors[1], glow2: colors[2], accent: colors[3] } };
}
function resolvedColors(theme, preferences) {
  const palette = paletteForTheme(theme, preferences);
  const defaults = presetCustomColors(theme, palette)[theme === 'dark' ? 'customDarkColors' : 'customLightColors'];
  const saved = preferences[theme === 'dark' ? 'customDarkColors' : 'customLightColors'];
  return saved && ['base', 'glow1', 'glow2', 'accent'].every(key => hex(saved[key])) ? saved : defaults;
}
function useHost(host) { return React.useSyncExternalStore(host.subscribe, host.getSnapshot); }
function usePaused() {
  const subscribe = React.useCallback(notify => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    media.addEventListener('change', notify);
    document.addEventListener('visibilitychange', notify);
    return () => { media.removeEventListener('change', notify); document.removeEventListener('visibilitychange', notify); };
  }, []);
  return React.useSyncExternalStore(subscribe,
    () => document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches, () => true);
}
export function AtelierAtmosphere(props) {
  const { theme, palette, className = 'absolute inset-0', layer, phase = 'idle', renderOriginal } = props;
  const effect = effects.some(([id]) => id === props.effect) ? props.effect : 'glow';
  const speed = clamp(props.speed, 0.25, 2, 1);
  const strength = clamp(props.intensity, 0, 1, 0.28);
  const mode = ['off', 'subtle', 'vivid'].includes(props.motionMode) ? props.motionMode : 'subtle';
  const paused = usePaused() || props.paused || mode === 'off';
  const preset = palettes[palette] || palettes[theme === 'dark' ? 'midnight' : 'milk'];
  const custom = props.customColors;
  const colors = custom?.enabled && ['base', 'glow1', 'glow2', 'accent'].every(key => hex(custom[key]))
    ? [custom.base, custom.glow1, custom.glow2, custom.accent] : preset.colors;
  const duration = ({ glow: 15, aurora: 12, silk: 20, liquid: 15, none: 15 })[effect] / speed;
  return h('div', {
    className: `hark-canvas-backdrop vivic-theme-atmosphere pointer-events-none overflow-hidden ${className}`,
    'aria-hidden': true, 'data-vivic-layer': layer,
    'data-vivic-atmosphere': palette, 'data-vivic-atmosphere-theme': theme,
    'data-space-effect': effect, 'data-space-speed': speed, 'data-space-strength': strength,
    'data-space-motion': mode, 'data-space-phase': phase,
    'data-space-running': !paused && strength > 0 && effect !== 'none',
    'data-reduced-motion': paused || undefined,
    style: { background: colors[0], '--atelier-base': colors[0], '--atelier-glow-1': colors[1],
      '--atelier-glow-2': colors[2], '--atelier-accent': colors[3], '--atelier-strength': strength,
      '--atelier-duration': `${duration}s`, '--atelier-travel': mode === 'vivid' ? '7%' : '4%',
      '--atelier-scale': mode === 'vivid' ? 1.18 : 1.10 }
  }, effect === 'liquid'
    ? h('div', { className: 'atelier-liquid-layer', style: { opacity: strength } },
        renderOriginal({ ...props, className: 'absolute inset-0', paused, speed, customColors: custom }))
    : effect !== 'none' && h('div', { className: 'atelier-glow-layer' }));
}

export function AtelierControls({ host, theme, disabled }) {
  const snapshot = useHost(host), p = snapshot.preferences;
  const [error, setError] = React.useState('');
  const save = patch => { const result = host.setPreferences(patch); setError(result.ok ? '' : '设置尚未保存，请重试。'); };
  const effect = effects.some(([id]) => id === p.backgroundEffect) ? p.backgroundEffect : 'glow';
  const motion = p.ambientMotion || 'subtle';
  const speed = clamp(p.ambientSpeed, 0.25, 2, 1);
  const strength = Math.round(clamp(p.ambientIntensity, 0, 1, 0.28) * 100);
  return h('details', { className: 'se-details atelier-settings', 'data-vivic-light-settings': true },
    h('summary', null, h('span', null, '空间光效'),
      h('span', { className: 'se-background-current' }, effects.find(([id]) => id === effect)[1], h('span', { 'aria-hidden': true }, '⌄'))),
    h('div', { className: 'se-detail-body atelier-control-body' },
      h('div', { className: 'atelier-effect-grid', role: 'group', 'aria-label': '背景效果' },
        effects.map(([id, label]) => h('button', { type: 'button', key: id, disabled,
          className: 'vivic-chip atelier-effect-choice', 'aria-pressed': effect === id,
          'data-vivic-background-effect': id, onClick: () => save({ backgroundEffect: id }) },
          h('span', { className: `atelier-effect-swatch atelier-effect-${id}`, 'aria-hidden': true }), label))),
      h('div', { role: 'group', 'aria-label': '空间动效', className: 'atelier-motion-options' },
        [['off', '暂停'], ['subtle', '柔和'], ['vivid', '灵动']].map(([id, label]) => h('button', {
          type: 'button', key: id, disabled, className: 'vivic-chip se-motion-choice',
          'aria-pressed': motion === id, 'data-vivic-motion-mode': id, onClick: () => save({ ambientMotion: id }) }, label))),
      h('label', { className: 'atelier-range-label' }, h('span', null, '流动速度'),
        h('output', { 'data-vivic-speed-value': true }, `${speed.toFixed(2)}×`),
        h('input', { type: 'range', min: 0.25, max: 2, step: 0.05, value: speed, disabled,
          'aria-label': '流动速度', onChange: e => save({ ambientSpeed: Number(e.target.value) }) })),
      h('label', { className: 'atelier-range-label' }, h('span', null, '光晕强度'),
        h('output', { 'data-vivic-strength-value': true }, `${strength}%`),
        h('input', { type: 'range', min: 0, max: 100, step: 1, value: strength, disabled,
          'aria-label': '光晕强度', onChange: e => save({ ambientIntensity: Number(e.target.value) / 100 }) })),
      (p.reducedMotion || motion === 'off') && h('p', { className: 'atelier-caption' }, '动效已暂停，配色和光晕保持静态。'),
      h('button', { type: 'button', disabled, className: 'vivic-chip atelier-reset', onClick: () => save({
        backgroundEffect: 'glow', ambientMotion: 'subtle', ambientSpeed: 1, ambientIntensity: 0.28
      }) }, '恢复默认光效'),
      error && h('p', { role: 'status', className: 'se-error' }, error)));
}

export function AtelierColorEditor({ host, theme, disabled }) {
  const snapshot = useHost(host), p = snapshot.preferences, colors = resolvedColors(theme, p);
  const field = theme === 'dark' ? 'customDarkColors' : 'customLightColors';
  const [error, setError] = React.useState('');
  const save = patch => { const result = host.setPreferences({ [field]: { ...colors, ...patch } }); setError(result.ok ? '' : '配色尚未保存，请重试。'); };
  return h('div', { className: 'atelier-custom-colors', 'data-vivic-custom-colors': theme },
    h('label', { className: 'atelier-custom-toggle' },
      h('span', null, `${theme === 'dark' ? '深色' : '浅色'}自选配色`),
      h('input', { type: 'checkbox', checked: !!colors.enabled, disabled, 'aria-label': '启用自选配色',
        onChange: e => save({ enabled: e.target.checked }) })),
    h('div', { className: 'atelier-color-grid' },
      [['base', '背景底色'], ['glow1', '光晕一'], ['glow2', '光晕二'], ['accent', '点缀色']].map(([key, label]) =>
        h('label', { key, className: 'atelier-color-field' }, h('span', null, label),
          h('div', { className: 'atelier-color-input' }, h('input', { type: 'color', value: colors[key], disabled,
            'aria-label': `${theme === 'dark' ? '深色' : '浅色'}${label}`, 'data-vivic-custom-color': key,
            onChange: e => hex(e.target.value) && save({ enabled: true, [key]: e.target.value }) }),
          h('code', null, colors[key].toUpperCase()))))),
    h('p', { className: 'atelier-caption' }, '深色和浅色各自保留一套自选配色；选择预设可切回预设颜色。'),
    error && h('p', { role: 'status', className: 'se-error' }, error));
}
