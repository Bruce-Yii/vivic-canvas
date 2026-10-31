// Transient presentation only. Card state and saving remain owned by the existing runtime.
let activeUI = null;
const CHANNEL = 'vivic.card-transfer.presentation.v1';
const DURATION = 1800;
const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const mix = (a, b, p) => a + (b - a) * p;
const ease = p => 1 - Math.pow(1 - clamp(p), 3);
const smooth = p => { p = clamp(p); return p * p * (3 - 2 * p); };

export function transferCard(cardId, target, perform) {
  return activeUI?.start(cardId, target, perform) ?? false;
}

export function mountCardTransferUI(config) {
  activeUI?.dispose();
  if (!config.root) return () => {};
  const jobs = new Map(), timers = new Set();
  let disposed = false, raf = 0, channel;
  const root = config.root;
  const layer = document.createElement('div');
  layer.className = 'vivic-transfer-overlay';
  layer.dataset.vivicTransferOverlay = config.surface;
  layer.setAttribute('aria-hidden', 'true');
  root.appendChild(layer);
  const status = document.createElement('div');
  status.className = 'vivic-transfer-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  root.appendChild(status);
  try { channel = new BroadcastChannel(CHANNEL); } catch {}
  const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; };
  const cards = () => config.getCards();
  const card = id => cards().find(c => c.id === id);
  const currentScope = () => config.getCanvasId() || '';
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || config.reducedMotion?.() === true;
  const actual = id => Array.from(root.querySelectorAll(config.surface === 'user' ? '[data-vivic-user-card]' : '.vivic-card[data-card-id]'))
    .find(el => !el.closest('[data-vivic-transfer-overlay]') && (el.dataset.vivicUserCard || el.dataset.cardId) === id);
  const post = message => { try { channel?.postMessage(message); } catch {} };
  function notify(text) {
    status.textContent = text;
    status.dataset.visible = 'true';
    later(() => { status.dataset.visible = 'false'; }, 3600);
  }
  function bounds(record) {
    const node = actual(record.id);
    if (node?.isConnected) {
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: r.left, y: r.top, width: r.width, height: r.height };
    }
    const layout = record.layout;
    if (config.surface === 'user') {
      const host = root.querySelector('[data-vivic-user-layer]');
      const r = host?.getBoundingClientRect() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
      const count = cards().filter(c => c.layout.surface === 'user').length;
      const width = Math.min(layout.width, Math.max(240, r.width - 16));
      const pos = layout.userPos ?? { x: 24 + count % 6 * 28, y: 72 + count % 6 * 28 };
      return { x: r.left + Math.round(clamp(pos.x, 8, Math.max(8, r.width - width - 8))) - (host?.scrollLeft ?? 0),
        y: r.top + Math.round(clamp(pos.y, 8, Math.max(8, r.height - 96))) - (host?.scrollTop ?? 0), width, height: layout.height };
    }
    const viewport = root.querySelector('.react-flow__viewport');
    const host = root.querySelector('.react-flow');
    const r = host?.getBoundingClientRect() ?? { left: 0, top: 0 };
    let matrix;
    try { matrix = new DOMMatrix(viewport ? getComputedStyle(viewport).transform : undefined); } catch { matrix = { a: 1, e: 0, f: 0 }; }
    return { x: r.left + matrix.e + layout.x * matrix.a, y: r.top + matrix.f + layout.y * matrix.a,
      width: layout.width * matrix.a, height: layout.height * matrix.a };
  }
  function copy(job, node) {
    if (job.copy || !node || !node.offsetWidth || !node.offsetHeight) return;
    const wrap = document.createElement('div');
    wrap.className = 'vivic-transfer-card-ghost';
    wrap.inert = true;
    const clone = node.cloneNode(true);
    clone.classList.remove('vivic-transfer-held');
    clone.classList.add('vivic-transfer-card-copy');
    for (const el of [clone, ...clone.querySelectorAll('*')]) {
      el.removeAttribute('id');
      for (const attribute of ['data-vivic-user-card', 'data-card-id', 'data-vivic-user-handle', 'data-vivic-move-handle']) el.removeAttribute(attribute);
    }
    clone.style.height = node.offsetHeight + 'px';
    wrap.appendChild(clone); job.scene.appendChild(wrap); job.copy = wrap;
    job.nativeWidth = node.offsetWidth; job.nativeHeight = node.offsetHeight;
  }
  function hold(job) {
    const el = actual(job.cardId);
    if (!el) return null;
    if (!job.source && card(job.cardId)?.layout.surface === config.surface) copy(job, el);
    el.classList.add('vivic-transfer-held');
    job.held.add(el);
    return el;
  }
  function newJob(message, source, perform) {
    const record = card(message.cardId);
    if (!record || jobs.has(message.id) || [...jobs.values()].some(j => j.cardId === message.cardId)) return null;
    const scene = document.createElement('div');
    scene.className = 'vivic-transfer-scene';
    scene.dataset.vivicTransferId = message.id;
    scene.dataset.vivicTransferRole = source ? 'send' : 'receive';
    scene.dataset.vivicTransferCard = message.cardId;
    const canvas = document.createElement('canvas');
    canvas.className = 'vivic-transfer-flow';
    const plane = document.createElement('div');
    plane.className = 'vivic-transfer-plane';
    const landing = document.createElement('div');
    landing.className = 'vivic-transfer-landing';
    const ring = document.createElement('div');
    ring.className = 'vivic-transfer-ring';
    scene.append(canvas, landing, ring, plane); layer.appendChild(scene);
    const job = { ...message, source, perform, scene, canvas, plane, landing, ring, record,
      held: new Set(), rect: bounds(record), started: message.started, confirmed: false, committed: false,
      invoked: false, peer: false, received: false, copy: null, failureAt: 0 };
    if (source) copy(job, actual(message.cardId));
    jobs.set(job.id, job); hold(job); schedule();
    return job;
  }
  function start(cardId, target, perform) {
    const record = card(cardId), scope = currentScope();
    if (disposed || !scope || !record || !['user', 'display'].includes(target) || target === config.surface ||
        (record.layout.surface ?? 'display') !== config.surface || !config.canTransfer() || [...jobs.values()].some(j => j.cardId === cardId)) return false;
    const message = { kind: 'prepare', id: crypto.randomUUID(), scope, cardId, from: config.surface, to: target, started: Date.now() };
    const job = newJob(message, true, perform ?? (() => config.perform(cardId, target)));
    if (!job) return false;
    post(message); return true;
  }
  function fail(job) {
    if (!job.failureAt) job.failureAt = Date.now();
  }
  function confirmation() {
    for (const job of jobs.values()) {
      const record = card(job.cardId);
      job.committed = !!record && (record.layout.surface ?? 'display') === job.to;
      hold(job);
      if (job.committed && !job.source && job.copy) {
        job.received = true;
        if (!job.receiptSent) { job.receiptSent = true; post({ kind: 'received', id: job.id, scope: job.scope }); }
      }
    }
  }
  function feedback(event) {
    if (event.detail?.kind !== 'transfer') return;
    confirmation();
    for (const job of jobs.values()) {
      if (event.detail.cardIds?.includes(job.cardId) && job.committed) {
        job.confirmed = true;
        if (job.pausedAt) { const wait = Date.now() - job.pausedAt; job.started += wait; job.pausedAt = 0; }
      }
    }
  }
  if (channel) channel.onmessage = event => {
    const m = event.data;
    if (!m || typeof m !== 'object' || m.scope !== currentScope() || typeof m.id !== 'string' || m.id.length > 64) return;
    if (m.kind === 'prepare' && m.to === config.surface && m.from !== config.surface &&
        typeof m.cardId === 'string' && m.cardId.length <= 128 && Math.abs(Date.now() - m.started) < 4000) {
      const job = newJob(m, false);
      if (job) post({ kind: 'ready', id: m.id, scope: m.scope });
    } else {
      const job = jobs.get(m.id);
      if (!job) return;
      if (m.kind === 'ready') job.peer = true;
      if (m.kind === 'received') job.received = true;
      if (m.kind === 'failed') fail(job);
    }
  };
  function finish(job, failed) {
    for (const el of job.held) el.classList.remove('vivic-transfer-held');
    actual(job.cardId)?.classList.remove('vivic-transfer-held');
    job.scene.remove(); jobs.delete(job.id);
    if (job.scope !== currentScope()) return;
    if (failed) {
      if (job.source) notify(job.committed ? '传送状态尚未确认，请刷新接收页查看' : '传送未完成，卡片仍在原位，请重试');
    } else if (job.source) notify('卡片已送达');
    else notify(config.surface === 'user' ? '卡片已抵达，可以继续编辑' : '卡片已抵达 Space');
  }
  function setGhost(job, opacity, scale, angle, dx = 0, dy = 0, blur = 0) {
    if (!job.copy) return;
    const r = job.rect;
    Object.assign(job.copy.style, { left: (r.x + r.width / 2) + 'px', top: (r.y + r.height / 2) + 'px',
      width: r.width + 'px', height: r.height + 'px', opacity: String(opacity), filter: `blur(${blur}px)`,
      transform: `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px)) perspective(900px) rotateX(${angle}deg) scale(${scale})` });
    const clone = job.copy.firstChild;
    clone.style.width = job.nativeWidth + 'px';
    clone.style.transform = `scale(${r.width / job.nativeWidth},${r.height / job.nativeHeight})`;
  }
  function route(job, t) {
    const r = job.rect, cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    return job.source ? { x: mix(cx, innerWidth + 60, t * t), y: mix(cy - 24, -60, t * t) }
      : { x: mix(-50, cx, ease(t)), y: mix(40, cy, ease(t)) };
  }
  function plane(job, x, y, opacity, scale = 1, angle = -12) {
    Object.assign(job.plane.style, { left: x + 'px', top: y + 'px', opacity: String(opacity),
      transform: `translate(-50%,-50%) rotate(${angle}deg) scale(${scale})` });
  }
  function paint(job, p, isReduced) {
    const canvas = job.canvas, ctx = canvas.getContext('2d'), width = innerWidth, height = innerHeight, dpr = Math.min(devicePixelRatio || 1, 1.5);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    if (isReduced) return;
    const r = job.rect, cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const background = document.querySelector('.vivic-shared-background');
    const style = getComputedStyle(background ?? root);
    const accent = style.getPropertyValue('--atelier-accent').trim() || '#5a8cc8';
    const glow = style.getPropertyValue('--atelier-glow-1').trim() || '#d0e4fd';
    job.scene.style.setProperty('--transfer-accent', accent);
    const pulse = Math.sin(Math.PI * clamp(p / .94));
    const g = ctx.createRadialGradient(cx, cy, 10, cx, cy, Math.max(width, height) * .7);
    g.addColorStop(0, glow); g.addColorStop(1, 'transparent');
    ctx.globalAlpha = pulse * .24; ctx.fillStyle = g; ctx.fillRect(0, 0, width, height); ctx.globalAlpha = 1;
    const local = job.source ? clamp((p - .31) / .21) : clamp((p - .42) / .25);
    const envelope = job.source ? smooth((p - .16) / .13) * (1 - smooth((p - .48) / .25))
      : job.confirmed ? smooth((p - .36) / .15) * (1 - smooth((p - .72) / .25)) : 0;
    for (let i = 0; i < 13 && envelope > 0; i++) {
      ctx.beginPath();
      for (let n = 0; n <= 40; n++) {
        const t = clamp(local - n * .014), point = route(job, t);
        const x = point.x - n / 6, y = point.y + (i - 6) * 3 + Math.sin(t * 12 + i * .7 + p * 8) * (4 + i * .65);
        n ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.globalAlpha = envelope * .17; ctx.strokeStyle = i % 2 ? accent : glow; ctx.lineWidth = 2 + i % 4;
      ctx.shadowColor = glow; ctx.shadowBlur = 12; ctx.stroke();
    }
    ctx.shadowBlur = 0;
    for (let i = 0; i < 19 && envelope > 0; i++) {
      const point = route(job, clamp(local - i * .022));
      ctx.globalAlpha = envelope * .4 * (1 - i / 24); ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(point.x + Math.cos(i * 4.6) * 9, point.y + Math.sin(i * 7.3) * 18, 1.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function schedule() { if (!raf && !disposed) raf = requestAnimationFrame(tick); }
  function tick() {
    raf = 0;
    const now = Date.now();
    confirmation();
    for (const job of jobs.values()) {
      if (job.scope !== currentScope()) { finish(job, true); continue; }
      const elapsed = now - job.started, small = reduced();
      if (job.source && !job.invoked && elapsed >= (small ? 0 : 290)) {
        job.invoked = true;
        try {
          Promise.resolve(job.perform()).then(result => { if (result === false || result?.ok === false) { fail(job); post({ kind: 'failed', scope: job.scope, id: job.id }); } })
            .catch(() => { fail(job); post({ kind: 'failed', scope: job.scope, id: job.id }); });
        } catch { fail(job); post({ kind: 'failed', scope: job.scope, id: job.id }); }
      }
      if (now - job.started > 6000 && !job.confirmed) fail(job);
      if ((!job.confirmed || job.source && job.peer && !job.received) && elapsed >= 720 && !job.failureAt) job.pausedAt ||= now;
      if (job.confirmed && job.received && job.pausedAt) { job.started += now - job.pausedAt; job.pausedAt = 0; }
      if (now - job.started > 6000 && job.confirmed && (job.source && !job.received || !job.source && !job.copy)) {
        finish(job, false); continue;
      }
      let p = clamp((job.pausedAt ? 720 : now - job.started) / DURATION);
      if (!job.source && job.committed) job.rect = bounds(card(job.cardId));
      const r = job.rect, cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      plane(job, cx, cy, 0); setGhost(job, 0, 1, 0);
      Object.assign(job.landing.style, { left: cx + 'px', top: cy + 'px', width: r.width + 'px', height: r.height + 'px',
        opacity: String(!job.source && p < .65 ? Math.sin(clamp((p - .06) / .59) * Math.PI) * .45 : 0) });
      Object.assign(job.ring.style, { left: cx + 'px', top: cy + 'px', opacity: String(!job.source && p > .58 && p < .98 && job.confirmed ? Math.sin((p - .58) / .4 * Math.PI) * .35 : 0),
        transform: `translate(-50%,-50%) scale(${mix(.65, 2.25, clamp((p - .58) / .4))})` });
      if (job.failureAt) {
        const f = clamp((now - job.failureAt) / 600);
        if (job.source && !job.committed) {
          plane(job, mix(innerWidth * .85, cx, ease(f)), mix(innerHeight * .1, cy, ease(f)) + Math.sin(f * Math.PI) * 70, 1 - smooth((f - .6) / .4), 1, mix(35, -12, ease(f)));
          setGhost(job, smooth((f - .55) / .45), mix(.25, 1, ease(clamp((f - .55) / .45))), mix(50, 0, ease(f)));
        }
        job.scene.style.opacity = String(1 - smooth((f - .7) / .3));
        paint(job, .4 * (1 - f), small);
        if (f >= 1) finish(job, true);
        continue;
      }
      if (small) {
        paint(job, 0, true);
        if (job.confirmed && (job.source || job.copy)) finish(job, false);
        continue;
      }
      if (job.source) {
        if (p < .17) { const t = smooth(p / .17); setGhost(job, 1, mix(1, 1.035, t), 7 * t, 0, -6 * t); }
        else if (p < .31) { const t = ease((p - .17) / .14); setGhost(job, 1 - smooth((t - .65) / .35), mix(1.035, .13, t), mix(7, 63, t), 0, mix(-6, -24, t), t * 2); plane(job, cx, cy - 24, smooth((t - .6) / .4)); }
        else if (p < .52) { const t = clamp((p - .31) / .21), point = route(job, t); plane(job, point.x, point.y, 1, mix(1, .62, t)); }
      } else if (job.confirmed && job.copy) {
        if (p > .42 && p < .67) { const t = clamp((p - .42) / .25), point = route(job, t); plane(job, point.x, point.y, 1, mix(.55, 1, t), mix(36, -12, ease(t))); }
        if (p >= .64) { const t = clamp((p - .64) / .22), scale = t < .72 ? mix(.16, 1.035, ease(t / .72)) : mix(1.035, 1, smooth((t - .72) / .28)); setGhost(job, smooth(t / .55), scale, mix(58, 0, ease(t)), 0, mix(-7, 0, ease(t))); if (p < .7) plane(job, cx, cy, 1 - smooth((p - .64) / .06)); }
      }
      paint(job, p, false);
      if (p >= 1 && job.confirmed) finish(job, false);
    }
    if (jobs.size) schedule();
  }
  const observer = new MutationObserver(confirmation);
  observer.observe(root, { childList: true, subtree: true });
  const unsubscribe = config.subscribe(confirmation);
  window.addEventListener('vivic:space-feedback', feedback);
  const onPageHide = () => { for (const job of [...jobs.values()]) finish(job, true); };
  window.addEventListener('pagehide', onPageHide);
  const ui = { start, dispose() {
    if (disposed) return; disposed = true; cancelAnimationFrame(raf);
    observer.disconnect(); unsubscribe?.(); channel?.close();
    window.removeEventListener('vivic:space-feedback', feedback); window.removeEventListener('pagehide', onPageHide);
    for (const job of jobs.values()) for (const el of job.held) el.classList.remove('vivic-transfer-held');
    timers.forEach(clearTimeout); jobs.clear(); layer.remove(); status.remove();
    if (activeUI === ui) activeUI = null;
  } };
  activeUI = ui;
  return () => ui.dispose();
}
