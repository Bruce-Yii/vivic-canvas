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
// Visual appearance only: no account, session, card or provider data is cached.
const VIVIC_BACKGROUND_KEY='vivic.visual-background.v1';
const vivicDefaultBackground={theme:'light',palette:'milk',colors:['#f3f7fb','#d0e4fd','#d6f3f2','#5a8cc8'],effect:'glow',speed:1,intensity:.28,motionMode:'subtle',animationOffset:0};
function vivicValidBackground(raw){
  if(!raw||!['light','dark'].includes(raw.theme)||!Array.isArray(raw.colors)||raw.colors.length!==4||!raw.colors.every(hex))return null;
  if(!['glow','aurora','silk','liquid','none'].includes(raw.effect))return null;
  return {theme:raw.theme,palette:palettes[raw.palette]?raw.palette:raw.theme==='dark'?'midnight':'milk',colors:raw.colors,
    effect:raw.effect,speed:clamp(raw.speed,.25,2,1),intensity:clamp(raw.intensity,0,1,.28),motionMode:['off','subtle','vivid'].includes(raw.motionMode)?raw.motionMode:'subtle',
    animationOffset:clamp(raw.animationOffset,0,160000,0)};
}
let vivicStoredBackground=null;
try{vivicStoredBackground=vivicValidBackground(window.__vivicInitialBackground||JSON.parse(localStorage.getItem(VIVIC_BACKGROUND_KEY)||'null'));}catch{}
let vivicBackgroundState={...(vivicStoredBackground||vivicDefaultBackground),paused:true,phase:'idle',renderOriginal:null};
const vivicBackgroundListeners=new Set(),vivicBackgroundOwners=new Map();
const vivicBackgroundSubscribe=notify=>{vivicBackgroundListeners.add(notify);return()=>vivicBackgroundListeners.delete(notify);};
const vivicBackgroundSnapshot=()=>vivicBackgroundState;
function vivicBackgroundTime(){
  const layer=document.querySelector('.vivic-shared-background > .atelier-glow-layer');
  const elapsed=Number(layer?.getAnimations?.()[0]?.currentTime)||0;
  const duration=({glow:15000,aurora:12000,silk:20000,liquid:15000,none:15000})[vivicBackgroundState.effect]/vivicBackgroundState.speed;
  return (vivicBackgroundState.animationOffset+elapsed)%(duration*2);
}
function vivicRememberBackground(){
  const value={...vivicBackgroundState,animationOffset:vivicBackgroundTime()};delete value.renderOriginal;delete value.paused;delete value.phase;
  try{localStorage.setItem(VIVIC_BACKGROUND_KEY,JSON.stringify(value));}catch{}
}
window.addEventListener('pagehide',vivicRememberBackground);
document.addEventListener('visibilitychange',()=>{if(document.hidden)vivicRememberBackground();});
function vivicSetBackground(owner,config,priority){
  vivicBackgroundOwners.set(owner,{config,priority});
  let active=null;for(const item of vivicBackgroundOwners.values())if(!active||item.priority>=active.priority)active=item;
  if(!active)return;
  let next=active.config;
  // Login and tutorial must not replace the last chosen background while the workspace is loading.
  if(active.priority===0&&vivicStoredBackground)next={...vivicBackgroundState,paused:next.paused,renderOriginal:next.renderOriginal};
  const old=vivicBackgroundState;
  const comparable=value=>JSON.stringify([value.theme,value.palette,value.colors,value.effect,value.speed,value.intensity,value.motionMode,value.paused,value.phase]);
  if(comparable(old)===comparable(next)&&!(next.effect==='liquid'&&old.renderOriginal!==next.renderOriginal))return;
  const sameMotion=old.effect===next.effect&&old.speed===next.speed;
  vivicBackgroundState={...next,animationOffset:sameMotion?old.animationOffset:0};
  document.documentElement.style.setProperty('--vivic-initial-base',next.colors[0]);
  document.documentElement.style.colorScheme=next.theme;
  vivicBackgroundListeners.forEach(notify=>notify());
  if(active.priority>0){vivicStoredBackground=vivicValidBackground(vivicBackgroundState);vivicRememberBackground();}
}
function vivicAtmosphereConfig(props){
  const preset=palettes[props.palette]||palettes[props.theme==='dark'?'midnight':'milk'];
  const custom=props.customColors;
  const colors=custom?.enabled&&['base','glow1','glow2','accent'].every(key=>hex(custom[key]))?[custom.base,custom.glow1,custom.glow2,custom.accent]:preset.colors;
  return {theme:props.theme==='dark'?'dark':'light',palette:palettes[props.palette]?props.palette:props.theme==='dark'?'midnight':'milk',colors,
    effect:effects.some(([id])=>id===props.effect)?props.effect:'glow',speed:clamp(props.speed,.25,2,1),intensity:clamp(props.intensity,0,1,.28),
    motionMode:['off','subtle','vivid'].includes(props.motionMode)?props.motionMode:'subtle',paused:!!props.paused,phase:props.phase||'idle',renderOriginal:props.renderOriginal};
}
export function AtelierAtmosphere(props){
  const owner=React.useRef(Symbol('background-controller'));
  const config=vivicAtmosphereConfig(props),key=JSON.stringify([config.theme,config.palette,config.colors,config.effect,config.speed,config.intensity,config.motionMode,config.paused,config.phase]);
  const priority=/hosted-atmosphere|vo-atmosphere/.test(props.className||'')?0:2;
  React.useLayoutEffect(()=>{vivicSetBackground(owner.current,config,priority);return()=>{vivicBackgroundOwners.delete(owner.current);};},[key,priority,props.renderOriginal]);
  return h('span',{'aria-hidden':true,'data-vivic-background-controller':true,className:`vivic-theme-atmosphere ${props.className||''}`,
    'data-vivic-atmosphere':config.palette,'data-vivic-atmosphere-theme':config.theme,'data-space-effect':config.effect,'data-space-speed':config.speed,
    'data-space-strength':config.intensity,'data-space-motion':config.motionMode,'data-space-running':!config.paused&&config.motionMode!=='off'&&config.intensity>0&&config.effect!=='none',
    style:{display:'none',backgroundColor:config.colors[0]}});
}
class VivicBackgroundBoundary extends React.Component{
  constructor(props){super(props);this.state={failed:false};}
  static getDerivedStateFromError(){return{failed:true};}
  componentDidCatch(error){window.__vivicStartup?.report('background',error);}
  render(){return this.state.failed?h(AtelierVisualAtmosphere,{...this.props.config,effect:'glow',customColors:this.props.colors,className:'vivic-shared-background'}):this.props.children;}
}
export function AtelierSharedBackground(){
  const config=React.useSyncExternalStore(vivicBackgroundSubscribe,vivicBackgroundSnapshot);
  const colors={enabled:true,base:config.colors[0],glow1:config.colors[1],glow2:config.colors[2],accent:config.colors[3]};
  const effect=config.effect==='liquid'&&!config.renderOriginal?'glow':config.effect;
  return h(VivicBackgroundBoundary,{key:config.effect,config,colors},h(AtelierVisualAtmosphere,{...config,effect,customColors:colors,className:'vivic-shared-background',layer:'shared'}));
}

function AtelierVisualAtmosphere(props) {
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
    : effect !== 'none' && h('div', { className: 'atelier-glow-layer', style: { animationDelay: String(-Math.max(0, props.animationOffset || 0)) + 'ms' } }));
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

function atelierNormalizeHex(text, allowShort = false) {
  const digits = text.trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(digits)) return '#' + digits.toUpperCase();
  if (allowShort && /^[0-9a-f]{3}$/i.test(digits)) return '#' + [...digits].map(c => c + c).join('').toUpperCase();
  return null;
}
function atelierHexToHsv(value) {
  const [r, g, b] = [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = delta === 0 ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: (hue * 60 + 360) % 360, saturation: max === 0 ? 0 : delta / max, brightness: max };
}
function atelierHsvToHex({ hue, saturation, brightness }) {
  const c = brightness * saturation, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = brightness - c;
  const rgb = hue < 60 ? [c,x,0] : hue < 120 ? [x,c,0] : hue < 180 ? [0,c,x] : hue < 240 ? [0,x,c] : hue < 300 ? [x,0,c] : [c,0,x];
  return '#' + rgb.map(value => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function AtelierColorPicker({ value, label, theme, onChange, onClose }) {
  const dialog = React.useRef(null), field = React.useRef(null);
  const [draft, setDraft] = React.useState(value.toUpperCase());
  const [hsv, setHsv] = React.useState(() => atelierHexToHsv(value));
  const [touched, setTouched] = React.useState(false);
  const errorId = React.useId();
  const normalized = atelierNormalizeHex(draft, true);
  React.useEffect(() => { setDraft(value.toUpperCase()); setHsv(atelierHexToHsv(value)); }, [value]);
  React.useEffect(() => {
    const element = dialog.current;
    element.showModal();
    field.current?.focus({ preventScroll: true });
    field.current?.select();
    return () => { if (element.open) element.close(); };
  }, []);
  const applyHsv = next => {
    setHsv(next); setTouched(false);
    const nextHex = atelierHsvToHex(next);
    setDraft(nextHex); onChange(nextHex);
  };
  const applyText = (text, allowShort = false) => {
    const next = atelierNormalizeHex(text, allowShort);
    if (!next) return false;
    setHsv(atelierHexToHsv(next)); onChange(next); return true;
  };
  const point = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    applyHsv({ ...hsv, saturation: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      brightness: 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) });
  };
  return h('dialog', { ref: dialog, className: 'atelier-color-dialog', 'data-theme': theme,
    'aria-label': `${label}取色器`, 'data-vivic-color-picker': true,
    onCancel: event => { event.preventDefault(); onClose(); }, onClose,
    onKeyDown: event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } },
    onClick: event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }
  }, h('form', { onSubmit: event => { event.preventDefault(); setTouched(true); if (applyText(draft, true)) onClose(); } },
    h('header', { className: 'atelier-picker-header' }, h('strong', null, label),
      h('button', { type: 'button', 'aria-label': '关闭取色器', onClick: onClose }, '×')),
    h('div', { className: 'atelier-picker-plane', role: 'slider', tabIndex: 0,
      'aria-label': '饱和度与亮度', 'aria-valuemin': 0, 'aria-valuemax': 100,
      'aria-valuenow': Math.round(hsv.saturation * 100),
      'aria-valuetext': `饱和度 ${Math.round(hsv.saturation * 100)}%，亮度 ${Math.round(hsv.brightness * 100)}%`,
      style: { backgroundColor: `hsl(${hsv.hue}, 100%, 50%)` },
      onPointerDown: event => { event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); point(event); },
      onPointerMove: event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) point(event); },
      onPointerUp: event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); },
      onKeyDown: event => {
        if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        applyHsv({ ...hsv, saturation: Math.max(0, Math.min(1, hsv.saturation + (event.key === 'ArrowRight' ? .01 : event.key === 'ArrowLeft' ? -.01 : 0))),
          brightness: Math.max(0, Math.min(1, hsv.brightness + (event.key === 'ArrowUp' ? .01 : event.key === 'ArrowDown' ? -.01 : 0))) });
      }
    }, h('span', { className: 'atelier-picker-cursor', 'aria-hidden': true,
      style: { left: `${hsv.saturation * 100}%`, top: `${(1-hsv.brightness)*100}%` } })),
    h('input', { className: 'atelier-picker-hue', type: 'range', min: 0, max: 359, step: 1,
      value: Math.round(hsv.hue), 'aria-label': '色相', onChange: event => applyHsv({ ...hsv, hue: Number(event.target.value) }) }),
    h('div', { className: 'atelier-picker-value-row' },
      h('span', { className: 'atelier-picker-preview', 'aria-hidden': true, style: { backgroundColor: value } }),
      h('label', { className: 'atelier-picker-hex-label' }, h('span', null, 'HEX'),
        h('input', { ref: field, type: 'text', value: draft, maxLength: 7, autoComplete: 'off', spellCheck: false,
          placeholder: '#RRGGBB', 'aria-label': 'HEX 色号', 'data-vivic-hex-input': true,
          'aria-invalid': touched && !normalized || undefined, 'aria-describedby': touched && !normalized ? errorId : undefined,
          onChange: event => { setDraft(event.target.value); setTouched(false); applyText(event.target.value); },
          onBlur: () => { setTouched(true); const next = atelierNormalizeHex(draft, true); if (next) { applyText(next); setDraft(next); } }
        }))),
    touched && !normalized && h('p', { id: errorId, role: 'status', className: 'atelier-picker-error' }, '请输入有效的 HEX 色号，例如 #1A1521。'),
    h('button', { className: 'atelier-picker-done', type: 'submit', disabled: !normalized }, '完成')));
}

export function AtelierColorEditor({ host, theme, disabled }) {
  const snapshot = useHost(host), p = snapshot.preferences, colors = resolvedColors(theme, p);
  const field = theme === 'dark' ? 'customDarkColors' : 'customLightColors';
  const [error, setError] = React.useState(''), [active, setActive] = React.useState(null);
  const triggers = React.useRef({});
  const labels = { base: '背景底色', glow1: '光晕一', glow2: '光晕二', accent: '点缀色' };
  const save = patch => { const result = host.setPreferences({ [field]: { ...colors, ...patch } }); setError(result.ok ? '' : '配色尚未保存，请重试。'); };
  const close = () => { const trigger = triggers.current[active]; setActive(null); requestAnimationFrame(() => trigger?.focus({ preventScroll: true })); };
  return h('div', { className: 'atelier-custom-colors', 'data-vivic-custom-colors': theme },
    h('label', { className: 'atelier-custom-toggle' },
      h('span', null, `${theme === 'dark' ? '深色' : '浅色'}自选配色`),
      h('input', { type: 'checkbox', checked: !!colors.enabled, disabled, 'aria-label': '启用自选配色',
        onChange: event => save({ enabled: event.target.checked }) })),
    h('div', { className: 'atelier-color-grid' }, Object.entries(labels).map(([key, label]) =>
      h('div', { key, className: 'atelier-color-field' }, h('span', null, label),
        h('button', { type: 'button', ref: element => { triggers.current[key] = element; },
          className: 'atelier-color-swatch', disabled, 'aria-label': `${theme === 'dark' ? '深色' : '浅色'}${label}`,
          'aria-haspopup': 'dialog', 'aria-expanded': active === key,
          'data-vivic-custom-color': key, style: { backgroundColor: colors[key] }, onClick: () => setActive(key) })))),
    active && h(AtelierColorPicker, { key: `${theme}-${active}`, value: colors[active], label: labels[active], theme,
      onChange: value => save({ enabled: true, [active]: value }), onClose: close }),
    error && h('p', { role: 'status', className: 'se-error' }, error));
}
