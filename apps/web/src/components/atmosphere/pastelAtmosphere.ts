/*
 * PastelAtmosphere — zero-dependency animated atmosphere background, ported
 * from the user-provided "VIVIIC 动态背景调色实验室" HTML (2026-10-17). The
 * shader, defaults and Canvas 2D fallback are kept as written there; only
 * TypeScript types were added, the PNG-export drawing buffer dropped and the
 * noise hash made precision-safe (see `hash` below).
 * The browser never makes any network requests for it.
 */
const vertex = `attribute vec2 a_pos;
    void main(){gl_Position=vec4(a_pos,0.,1.);}`;
const fragment = `precision highp float;
    uniform vec2 u_resolution;
    uniform float u_time, u_density, u_speed, u_glow, u_brightness, u_dark;
     uniform vec2 u_direction;
    uniform int u_mode;
    uniform vec3 u_base, u_colorA, u_colorB, u_colorC;
    // sin-free hash: the lab's fract(sin(dot(p,..))*43758.5) disagrees across
    // noise-cell edges on some GPUs (seen on Intel Arc / ANGLE D3D11) and
    // leaves rectangular seams; this one is stable and keeps the same texture.
    float hash(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
    float noise(vec2 p){
      vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);
    }
    float fbm(vec2 p){
      float v=0.; float a=.53;
      for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.03+vec2(8.27,1.41);a*=.49;}
      return v;
    }
    float ell(vec2 p, vec2 center, vec2 rad){vec2 z=(p-center)/rad;return exp(-dot(z,z)*1.16);}
    void main(){
      vec2 p=(gl_FragCoord.xy-0.5*u_resolution)/u_resolution.y;
      float t=u_time*(.09+u_speed*.0041);
      float k=u_density*.01;
      float glow=u_glow*.01;
      vec2 wind=u_direction*t*.22;
      vec2 warp=vec2(fbm(p*1.18+wind),fbm(p*1.23-vec2(t*.11,-t*.17)+7.31));
      vec2 q=p+(.42+float(u_mode)*.035)*(warp-.5);
      float n1=fbm(q*1.79+vec2(t*.08,-t*.09));
      float n2=fbm(q*2.35+vec2(-t*.1,t*.075)+3.94);
      float n3=fbm(q*3.4+vec2(t*.12,-t*.15)+8.81);
      vec3 col=u_base;
      float a=0.,b=0.,c=0.;
      if(u_mode==0){
        // Cloud-light: a soft blur of drifting wisps and luminous pools
        float veil=smoothstep(.34,.78,n1*.79+n3*.23);
        a=ell(q,vec2(-.54+sin(t*.42)*.13,.11),vec2(.76,.61))*(.60+.48*n1);
        b=ell(q,vec2(.47+cos(t*.33)*.12,-.11),vec2(.79,.49))*(.59+.62*n2);
        c=ell(q,vec2(.03+sin(t*.22)*.18,.32),vec2(.67,.42))*(.30+.62*veil);
        a+=.20*veil;
      }else if(u_mode==1){
        // Ether: slow liquid plumes, warped and curled like ink in water
        float fold=sin(q.y*7.8+sin(q.x*3.8-t*.45)*1.5+warp.x*5.7-t*.33);
        float eddy=smoothstep(-.77,.84,fold)*(.27+.73*n1);
        a=ell(q,vec2(-.47,-.07),vec2(.79,.65))*(.42+.52*eddy);
        b=ell(q,vec2(.36,.15),vec2(.77,.64))*(.44+.42*n2);
        c=ell(q,vec2(.04,-.18),vec2(.68,.38))*(.2+.65*eddy);
      }else if(u_mode==2){
        // Silk: broad soft fabric ribbons with smooth folded highlights
        float ridge=sin(q.y*9.4+sin(q.x*2.6+t*.21)*1.24+q.x*2.5-t*.45);
        float ribbon=.5+.5*ridge;
        a=smoothstep(.28,.86,ribbon)*ell(q,vec2(-.31,0.),vec2(1.35,.85))*.79;
        b=smoothstep(.22,.86,1.-ribbon)*ell(q,vec2(.36,.0),vec2(1.24,.85))*.72;
        c=ell(q,vec2(.04,.08),vec2(.72,.58))*(.19+.38*n1);
      }else if(u_mode==3){
        // Fog: broad cloud banks whose density changes in an organic way
        float cloud=smoothstep(.28,.74,n1*.7+n2*.38);
        float cloud2=smoothstep(.3,.76,n2*.73+n3*.33);
        a=ell(q,vec2(-.55+sin(t*.23)*.2,.17),vec2(1.07,.55))*(.39+.65*cloud);
        b=ell(q,vec2(.52+cos(t*.19)*.13,-.21),vec2(.99,.58))*(.46+.62*cloud2);
        c=ell(q,vec2(.0,.27),vec2(.84,.44))*(.25+.43*cloud);
      }else if(u_mode==4){
        // Aurora: translucent vertical light curtains with a gentle sway
        float bend=sin(p.x*3.7+t*.24)*.21+sin(p.y*2.1-t*.3)*.10;
        float v1=exp(-pow((q.x+.37+bend)*2.08,2.));
        float v2=exp(-pow((q.x-.3-bend*.77)*2.13,2.));
        a=v1*(.52+.30*n1)*(.65+.34*sin(p.y*1.9-t*.1));
        b=v2*(.58+.28*n2);
        c=exp(-pow((q.x+.04+bend*.8)*2.2,2.))*(.38+.25*n3);
      }else{
        // Grainient: large abstract color gradients with subtle micrograin
        a=ell(q,vec2(-.62+sin(t*.24)*.2,.23),vec2(.99,.78))*(.53+.35*n1);
        b=ell(q,vec2(.49+cos(t*.22)*.11,-.24),vec2(.99,.72))*(.49+.43*n2);
        c=ell(q,vec2(.15,.35),vec2(.8,.56))*(.34+.36*n3);
      }
      float gain=.38+.53*k;
      col=mix(col,u_colorA,clamp(a*gain,0.,.76));
      col=mix(col,u_colorB,clamp(b*gain,0.,.69));
      col=mix(col,u_colorC,clamp(c*gain,0.,.62));
      float haze=ell(p,vec2(-.22+sin(t*.29)*.17,.20),vec2(.57,.49));
      float shine=ell(p,vec2(.53+cos(t*.25)*.11,.06),vec2(.61,.57));
      col=mix(col,u_dark>.5?mix(u_colorA,u_colorB,.46):vec3(1.),clamp((u_dark>.5?.22:.12)*glow*haze+.045*glow*shine,0.,u_dark>.5?.29:.24));
      col=mix(col,u_colorB,clamp(.12*glow*shine,0.,.17));
      float shift=(u_brightness-65.)/100.;
      col=mix(col,vec3(1.),max(0.,shift)*.77);
      col=mix(col,vec3(.9,.91,.95),max(0.,-shift)*.23);
      // A gossamer hint of drifting microtexture, strongest on Grainient.
      float grain=(hash(gl_FragCoord.xy+floor(t*2.))-.5);
      col+=grain*(u_mode==5?.016:.0045);
      gl_FragColor=vec4(clamp(col,0.,1.),1.);
    }`;

export type AtmosphereDirection = "right" | "left" | "up" | "down";
export interface AtmosphereOptions {
  /** 0 云雾光晕 · 1 流光以太 · 2 丝绸柔光 · 3 漫游烟雾 · 4 晨曦极光 · 5 柔粒渐变 */
  mode: number;
  colors: string[];
  density: number; speed: number; glow: number; brightness: number;
  dark: number;
  direction: AtmosphereDirection;
}

const defaults: AtmosphereOptions = {
  mode: 0,
  colors: ["#F8FAFF", "#BCD7FA", "#DEC9FA", "#FADCEA"],
  density: 68, speed: 43, glow: 66, brightness: 70, dark: 1, direction: "right",
};
const UNIFORMS = ["u_resolution", "u_time", "u_density", "u_speed", "u_glow", "u_brightness", "u_dark", "u_direction", "u_mode", "u_base", "u_colorA", "u_colorB", "u_colorC"] as const;
type UniformName = (typeof UNIFORMS)[number];

function rgb(hex: string): [number, number, number] {
  const h = String(hex || "#FFFFFF").replace("#", "");
  const full = h.length === 3 ? h.split("").map(x => x + x).join("") : h;
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}
function alpha(hex: string, a: number) { const x = rgb(hex).map(v => Math.round(v * 255)); return `rgba(${x.join(",")},${a})`; }

export class PastelAtmosphere {
  canvas: HTMLCanvasElement;
  options: AtmosphereOptions;
  gl: WebGLRenderingContext | null = null;
  private fallback: CanvasRenderingContext2D | null = null;
  private program: WebGLProgram | null = null;
  private uniforms = {} as Record<UniformName, WebGLUniformLocation | null>;
  private paused = false;
  private time = 0;
  private last = 0;
  private running = true;
  private frameId = 0;
  private observer?: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, options: Partial<AtmosphereOptions> = {}) {
    this.canvas = canvas;
    this.options = { ...defaults, ...options, colors: [...(options.colors || defaults.colors)] };
    this.frame = this.frame.bind(this);
    this.resize = this.resize.bind(this);
    this.setup();
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(this.resize); this.observer.observe(this.canvas);
    } else { window.addEventListener("resize", this.resize); }
    this.resize();
    this.frameId = requestAnimationFrame(this.frame);
  }
  private setup() {
    const gl = this.canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: "low-power" });
    if (!gl) { this.fallback = this.canvas.getContext("2d"); return; }
    try {
      const compile = (kind: number, code: string) => {
        const s = gl.createShader(kind)!; gl.shaderSource(s, code); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader"); return s;
      };
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program");
      gl.useProgram(program);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(program, "a_pos"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      UNIFORMS.forEach(k => { this.uniforms[k] = gl.getUniformLocation(program, k); });
      this.gl = gl;
      this.program = program;
    } catch (e) {
      console.warn("Atmosphere WebGL unavailable; use Canvas 2D fallback.", e);
      // A failed WebGL initialization owns the canvas context; replace its DOM node to allow 2D.
      const copy = this.canvas.cloneNode(false) as HTMLCanvasElement;
      this.canvas.parentNode?.replaceChild(copy, this.canvas);
      this.canvas = copy;
      this.fallback = copy.getContext("2d");
    }
  }
  resize() {
    const box = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    const pixelScale = .81;
    const w = Math.max(1, Math.floor(box.width * dpr * pixelScale));
    const h = Math.max(1, Math.floor(box.height * dpr * pixelScale));
    if (w !== this.canvas.width || h !== this.canvas.height) {
      this.canvas.width = w; this.canvas.height = h;
      if (this.gl) this.gl.viewport(0, 0, w, h);
      this.render();
    }
  }
  setOptions(updates: Partial<AtmosphereOptions> = {}) {
    this.options = { ...this.options, ...updates, colors: updates.colors ? [...updates.colors] : this.options.colors };
    this.render();
  }
  setPaused(paused: boolean) { this.paused = !!paused; this.render(); }
  private frame(now: number) {
    if (!this.running) return;
    if (this.last && !this.paused) this.time += Math.min((now - this.last) * .001, .07);
    this.last = now;
    if (!this.paused) this.render();
    this.frameId = requestAnimationFrame(this.frame);
  }
  render() {
    if (!this.running || !this.canvas.width || !this.canvas.height) return;
    const o = this.options;
    if (this.gl) {
      const g = this.gl, u = this.uniforms;
      g.useProgram(this.program);
      g.uniform2f(u.u_resolution, this.canvas.width, this.canvas.height);
      g.uniform1f(u.u_time, this.time);
      g.uniform1f(u.u_density, o.density);
      g.uniform1f(u.u_speed, o.speed);
      g.uniform1f(u.u_glow, o.glow);
      g.uniform1f(u.u_brightness, o.brightness);
      g.uniform1f(u.u_dark, o.dark ? 1 : 0);
      const dirs: Record<AtmosphereDirection, [number, number]> = { right: [1, .12], left: [-1, -.12], up: [.12, 1], down: [-.12, -1] };
      const dv = dirs[o.direction] || dirs.right;
      g.uniform2f(u.u_direction, dv[0], dv[1]);
      g.uniform1i(u.u_mode, o.mode);
      [u.u_base, u.u_colorA, u.u_colorB, u.u_colorC].forEach((location, i) => g.uniform3fv(location, new Float32Array(rgb(o.colors[i]))));
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    } else if (this.fallback) { this.paintFallback(this.fallback); }
  }
  private paintFallback(c: CanvasRenderingContext2D) {
    const w = this.canvas.width, h = this.canvas.height, o = this.options;
    c.clearRect(0, 0, w, h);
    c.fillStyle = o.colors[0]; c.fillRect(0, 0, w, h);
    const t = this.time * (.025 + o.speed * .0012), d = .32 + .46 * o.density * .01;
    const shapes: Array<[number, number, number, string]> = [
      [.27 + Math.sin(t * (o.direction === "left" ? -1 : 1)) * .12, .26 + Math.cos(t * .72) * .1, .77, o.colors[1]],
      [.76 + Math.cos(t * .81) * .1, .74 + Math.sin(t * .72) * .13, .8, o.colors[2]],
      [.48 + Math.sin(t * .61) * .16, .37 + Math.cos(t * .56) * .12, .64, o.colors[3]],
    ];
    c.globalCompositeOperation = "source-over";
    shapes.forEach(([x, y, r, color]) => {
      const gx = x * w, gy = y * h, rad = Math.max(w, h) * r * .79;
      const grad = c.createRadialGradient(gx, gy, 0, gx, gy, rad);
      grad.addColorStop(0, alpha(color, .75 * d)); grad.addColorStop(.3, alpha(color, .46 * d)); grad.addColorStop(1, alpha(color, 0));
      c.fillStyle = grad; c.fillRect(0, 0, w, h);
    });
    // Organic, translucent smoke ribbons remain animated even without WebGL.
    if (o.mode === 0 || o.mode === 1 || o.mode === 3) {
      c.lineCap = "round";
      const repeats = o.mode === 3 ? 21 : o.mode === 1 ? 16 : 11;
      for (let j = 0; j < repeats; j++) {
        const yBase = h * (.02 + j * (o.mode === 3 ? .050 : .075));
        c.beginPath();
        for (let i = 0; i <= 55; i++) {
          const x = -w * .11 + (i / 55) * w * 1.22;
          const phase = i / 55 * 9.6 + j * .39 + t * (o.mode === 1 ? 1.24 : .59);
          const amp = h * (o.mode === 1 ? .105 : o.mode === 0 ? .056 : .032);
          const y = yBase + Math.sin(phase) * amp + Math.sin(phase * .53 + j * 1.6) * h * .023;
          if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.lineWidth = h * (o.mode === 3 ? .073 : .039);
        c.strokeStyle = alpha(o.colors[j % 3 + 1], (o.mode === 3 ? .048 : o.mode === 1 ? .071 : .040) * d);
        c.stroke();
      }
    }
    // Light veil ribbons in canvas-only environments.
    if (o.mode === 2 || o.mode === 4) {
      c.lineCap = "round";
      for (let i = 0; i < 15; i++) {
        const yy = h * (.11 + i * .058), phase = t * .7 + i * .27;
        c.beginPath();
        for (let j = 0; j <= 34; j++) {
          const x = j / 34 * w, y = yy + Math.sin(x / w * 5.8 + phase) * h * .10;
          if (j === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.strokeStyle = alpha(o.colors[i % 3 + 1], .06 * d); c.lineWidth = h * .045; c.stroke();
      }
    }
    if (o.mode === 5) {
      for (let i = 0; i < 400; i++) {
        c.fillStyle = "rgba(255,255,255,.024)";
        c.fillRect((i * 1337.39) % w, (i * 2323.19) % h, 1, 1);
      }
    }
  }
  destroy() {
    this.running = false; cancelAnimationFrame(this.frameId);
    this.observer?.disconnect(); if (!this.observer) window.removeEventListener("resize", this.resize);
  }
}
