import{AtelierAtmosphere as VivicAtelierAtmosphere}from"./atelier-background.js";
import{i as e}from"./rolldown-runtime-Dd_uD5pT.js";import{t}from"./react-CQOZoUwg.js";import{t as n}from"./jsx-runtime-DREnUpxT.js";import{F as r,I as i,J as a,M as o,q as s,r as c,t as l,v as u,y as d}from"./react-DdN5SUqT.js";import{t as f}from"./use-reduced-motion-Dl6x9R7S.js";import{ct as p,lt as m,ut as h}from"./browserRuntime-CMMGoec6.js";import{t as g}from"./palettes-y4eFPjSE.js";import{t as _}from"./dist-Bcow9Ss5.js";function v(...e){let t=!Array.isArray(e[0]),n=t?0:-1,r=e[0+n],i=e[1+n],a=e[2+n],s=e[3+n],c=o(i,a,s);return t?c(r):c}var y=e(t(),1);function b(e){let t=a(()=>d(e)),{isStatic:n}=(0,y.useContext)(c);if(n){let[,n]=(0,y.useState)(e);(0,y.useEffect)(()=>t.on(`change`,n),[])}return t}function x(e,t){let n=b(t()),a=()=>n.set(t());return a(),s(()=>{let t=()=>i.preRender(a,!1,!0),n=e.map(e=>e.on(`change`,t));return a(),()=>{n.forEach(e=>e()),r(a)}}),n}function S(e){u.current=[],e();let t=x(u.current,e);return u.current=void 0,t}function C(e,t,n,r){if(typeof e==`function`)return S(e);if(n!==void 0&&!Array.isArray(n)&&typeof t!=`function`)return T(e,t,n,r);let i=typeof t==`function`?t:v(t,n,r),a=Array.isArray(e)?w(e,i):w([e],([e])=>i(e)),o=Array.isArray(e)?void 0:e.accelerate;if(o&&!o.isTransformed&&typeof t!=`function`&&Array.isArray(n)&&r?.clamp!==!1){let e=r?.ease;a.accelerate={...o,times:[0,...t,1],keyframes:[n[0],...n,n[n.length-1]],isTransformed:!0,...e?{ease:Array.isArray(e)?[e[0],...e]:e}:{}}}return a}function w(e,t){let n=a(()=>[]);return x(e,()=>{n.length=0;let r=e.length;for(let t=0;t<r;t++)n[t]=e[t].get();return t(n)})}function T(e,t,n,r){let i=a(()=>Object.keys(n)),o=a(()=>({}));for(let a of i)o[a]=C(e,t,n[a],r);return o}var E=()=>typeof window<`u`&&typeof window.matchMedia==`function`?window.matchMedia(`(prefers-reduced-motion: reduce)`):null,D=e=>{let t=E();return t?.addEventListener(`change`,e),()=>t?.removeEventListener(`change`,e)},O=()=>(0,y.useSyncExternalStore)(D,()=>E()?.matches??!1,()=>!1);function k(){let e=(0,y.useRef)(null),[t,n]=(0,y.useState)(()=>typeof document>`u`||document.visibilityState!==`hidden`);return(0,y.useEffect)(()=>{let t=!0,r=()=>n(document.visibilityState!==`hidden`&&t),i=typeof IntersectionObserver==`function`?new IntersectionObserver(e=>{t=e.some(e=>e.isIntersecting),r()}):null;return e.current&&i?.observe(e.current),document.addEventListener(`visibilitychange`,r),r(),()=>{i?.disconnect(),document.removeEventListener(`visibilitychange`,r)}},[]),{ref:e,visible:t}}var A=n(),ee=24e5,te=14e4,ne=32,j=256,M=`#version 300 es
const vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() {
  vUv = corners[gl_VertexID] * 0.5 + 0.5;
  gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
}`,N=`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform vec2 uTexel;
`,re=`${N}
uniform sampler2D uVelocity;
uniform vec2 uSize;
uniform vec4 uSegment;
uniform vec2 uForce;
uniform float uRadius;

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
  return length(p - a - ab * t);
}

void main() {
  float d = segment(vUv * uSize, uSegment.xy, uSegment.zw) / uRadius;
  vec2 velocity = texture(uVelocity, vUv).xy + uForce * exp(-d * d * 6.0);
  fragColor = vec4(velocity, 0.0, 1.0);
}`,ie=`${N}
uniform sampler2D uVelocity;
uniform float uAmount;

void main() {
  vec2 center = texture(uVelocity, vUv).xy;
  vec2 around =
    texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).xy +
    texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).xy +
    texture(uVelocity, vUv - vec2(0.0, uTexel.y)).xy +
    texture(uVelocity, vUv + vec2(0.0, uTexel.y)).xy;
  fragColor = vec4(mix(center, around * 0.25, uAmount), 0.0, 1.0);
}`,ae=`${N}
uniform sampler2D uVelocity;
uniform float uWalls;

void main() {
  vec2 center = texture(uVelocity, vUv).xy;
  float left = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float right = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float down = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  float up = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  float edge = uWalls > 0.5 ? -1.0 : 0.0;
  if (vUv.x - uTexel.x < 0.0) left = edge * center.x;
  if (vUv.x + uTexel.x > 1.0) right = edge * center.x;
  if (vUv.y - uTexel.y < 0.0) down = edge * center.y;
  if (vUv.y + uTexel.y > 1.0) up = edge * center.y;
  fragColor = vec4(0.5 * (right - left + up - down), 0.0, 0.0, 1.0);
}`,P=`
uniform float uWalls;

float pressureAt(sampler2D field, vec2 uv) {
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(field, uv).x * mix(inside.x * inside.y, 1.0, uWalls);
}
`,oe=`${N}
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
${P}
void main() {
  vec2 reach = uTexel * 2.0;
  float sum =
    pressureAt(uPressure, vUv - vec2(reach.x, 0.0)) +
    pressureAt(uPressure, vUv + vec2(reach.x, 0.0)) +
    pressureAt(uPressure, vUv - vec2(0.0, reach.y)) +
    pressureAt(uPressure, vUv + vec2(0.0, reach.y));
  fragColor = vec4(sum * 0.25 - texture(uDivergence, vUv).x, 0.0, 0.0, 1.0);
}`,se=`${N}
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
${P}
void main() {
  float left = pressureAt(uPressure, vUv - vec2(uTexel.x, 0.0));
  float right = pressureAt(uPressure, vUv + vec2(uTexel.x, 0.0));
  float down = pressureAt(uPressure, vUv - vec2(0.0, uTexel.y));
  float up = pressureAt(uPressure, vUv + vec2(0.0, uTexel.y));
  vec2 velocity = texture(uVelocity, vUv).xy - 0.5 * vec2(right - left, up - down);
  fragColor = vec4(velocity, 0.0, 1.0);
}`,ce=`${N}
uniform sampler2D uVelocity;
uniform vec2 uStep;
uniform float uKeep;
uniform float uWalls;

vec2 at(vec2 uv) {
  vec2 outside = max(-uv, uv - 1.0) / uTexel;
  float open = clamp(1.0 - max(outside.x, outside.y) / 1.5, 0.0, 1.0);
  return texture(uVelocity, uv).xy * mix(open, 1.0, uWalls);
}

void main() {
  vec2 start = vUv - at(vUv) * uStep;
  vec2 back = start + at(start) * uStep;
  vec2 corrected = vUv - (back - vUv) * 0.5;
  vec2 origin = corrected - at(corrected) * uStep;
  vec2 a = at(origin + vec2(-0.5, -0.5) * uTexel);
  vec2 b = at(origin + vec2(0.5, -0.5) * uTexel);
  vec2 c = at(origin + vec2(-0.5, 0.5) * uTexel);
  vec2 d = at(origin + vec2(0.5, 0.5) * uTexel);
  vec2 velocity = clamp(at(origin), min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));
  fragColor = vec4(velocity * uKeep, 0.0, 1.0);
}`,le=`${N}
uniform sampler2D uVelocity;
uniform sampler2D uPalette;
uniform vec2 uSimSize;
uniform float uSpeedScale;
uniform float uLight;
uniform vec4 uBackground;

vec2 velocityAt(vec2 uv) {
  vec2 st = uv * uSimSize - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0;
  vec2 w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / uSimSize;
  vec2 h1 = (i + 1.5 + w3 / g1) / uSimSize;
  vec2 a = texture(uVelocity, vec2(h0.x, h0.y)).xy;
  vec2 b = texture(uVelocity, vec2(h1.x, h0.y)).xy;
  vec2 c = texture(uVelocity, vec2(h0.x, h1.y)).xy;
  vec2 d = texture(uVelocity, vec2(h1.x, h1.y)).xy;
  return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}

void main() {
  float speed = length(velocityAt(vUv)) * uSpeedScale;
  float level = speed < 0.75 ? speed : 0.75 + 0.25 * tanh((speed - 0.75) * 4.0);
  vec3 ink = texture(uPalette, vec2(level, 0.5)).rgb;
  float alpha = level;
  if (uLight > 0.5) {
    float hollow = smoothstep(0.7, 1.6, speed);
    alpha = smoothstep(0.08, 0.5, level) * mix(0.85, 0.1, hollow);
  } else {
    float hot = 1.0 - exp(-max(speed - 0.75, 0.0) * 1.2);
    ink = mix(ink, min(ink * 1.8 + 0.06, vec3(1.0)), hot);
  }
  vec3 color = ink * alpha + uBackground.rgb * uBackground.a * (1.0 - alpha);
  float coverage = alpha + uBackground.a * (1.0 - alpha);
  float grain = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  color += (grain - 0.5) / 255.0 * step(0.002, coverage);
  fragColor = vec4(clamp(color, vec3(0.0), vec3(coverage)), coverage);
}`,F=(e,t,n)=>Math.min(n,Math.max(t,e)),ue=(e,t)=>.5**(t/(.35+e*e*12)),I=e=>{let t=String(e||``).trim(),n=/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);if(n){let e=n[1].length===3?n[1].replace(/./g,e=>e+e):n[1];return[0,2,4].map(t=>parseInt(e.slice(t,t+2),16)/255)}let r=/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(t);return r?[r[1],r[2],r[3]].map(e=>F(parseFloat(e)/255,0,1)):null},L=e=>e<=.04045?e/12.92:((e+.055)/1.055)**2.4,de=e=>{let t=[];e.forEach(e=>{let n=I(e);n&&t.push(n)}),t.length||t.push([1,1,1]);let n=t.map(e=>e.map(L)),r=new Uint8Array(j*4);for(let e=0;e<j;e++){let t=F(e/255*n.length-.5,0,n.length-1),i=Math.min(Math.floor(t),Math.max(n.length-2,0)),a=Math.min(i+1,n.length-1),o=t-i,s=o*o*(3-2*o);for(let t=0;t<3;t++){let o=n[i][t]+(n[a][t]-n[i][t])*s;r[e*4+t]=Math.round(F(o,0,1)*255)}r[e*4+3]=255}return r},R=(e,t,n)=>{let r=e.createShader(t);return r?(e.shaderSource(r,n),e.compileShader(r),e.getShaderParameter(r,e.COMPILE_STATUS)?r:(console.error(e.getShaderInfoLog(r)),e.deleteShader(r),null)):null},z=(e,t)=>{let n=R(e,e.VERTEX_SHADER,M),r=R(e,e.FRAGMENT_SHADER,t),i=n&&r?e.createProgram():null;if(!n||!r||!i)return n&&e.deleteShader(n),r&&e.deleteShader(r),null;if(e.attachShader(i,n),e.attachShader(i,r),e.linkProgram(i),e.deleteShader(n),e.deleteShader(r),!e.getProgramParameter(i,e.LINK_STATUS))return console.error(e.getProgramInfoLog(i)),e.deleteProgram(i),null;let a={},o=e.getProgramParameter(i,e.ACTIVE_UNIFORMS);for(let t=0;t<o;t++){let n=e.getActiveUniform(i,t);n&&(a[n.name]=e.getUniformLocation(i,n.name))}return{program:i,uniforms:a}},fe=({colors:e=[`#5227FF`,`#FF9FFC`,`#B497CF`],intensity:t=1,mouseForce:n=20,cursorSize:r=100,persistence:i=.75,viscosity:a=0,resolution:o=.5,bounceEdges:s=!1,clickBurst:c=!0,interactive:l=!0,autoDemo:u=!0,autoSpeed:d=.5,autoIntensity:f=2.2,autoResumeDelay:p=1e3,intro:m=!0,lightMode:h=!1,backgroundColor:g=`transparent`,maxDevicePixelRatio:_=2,className:v=``,style:b})=>{let x=(0,y.useRef)(null),S=(0,y.useRef)(null),C=(0,y.useRef)(null),[w,T]=(0,y.useState)(0),E=Array.isArray(e)?e:[e],D=g===`transparent`?null:I(g),O={colors:E,paletteKey:E.join(`,`),intensity:Math.max(0,t),force:Math.max(0,n),radius:F(r,4,600),persistence:F(i,0,1),viscosity:F(a,0,1),resolution:F(o,.05,1),walls:s,clickBurst:c,interactive:l,autoDemo:u,autoSpeed:Math.max(0,d),autoIntensity:Math.max(0,f),autoResumeDelay:Math.max(0,p),intro:m,light:h,background:D?[...D,1]:[0,0,0,0],maxRatio:F(_,.5,3)},k=(0,y.useRef)(O);return k.current=O,(0,y.useEffect)(()=>{C.current?.()}),(0,y.useEffect)(()=>{let e=x.current,t=S.current;if(!e||!t)return;let n=t.getContext(`webgl2`,{alpha:!0,premultipliedAlpha:!0,antialias:!1,depth:!1,stencil:!1,powerPreference:`high-performance`});if(!n||!n.getExtension(`EXT_color_buffer_float`)&&!n.getExtension(`EXT_color_buffer_half_float`))return;let r={splat:z(n,re),smooth:z(n,ie),divergence:z(n,ae),pressure:z(n,oe),project:z(n,se),advect:z(n,ce),display:z(n,le)};if(Object.values(r).some(e=>!e))return;let i=window.matchMedia(`(prefers-reduced-motion: reduce)`).matches,a=n.createVertexArray(),o={width:1,height:1},s={width:0,height:0},c={},l={x:0,y:0,fromX:0,fromY:0,dx:0,dy:0,inside:!1,ready:!1,moved:!1,last:0},u={phase:Math.random()*100,x:0,y:0,ready:!1,ramp:0},d={active:k.current.intro&&!i&&w===0,time:0},f=[],p=[],m=1,h=-1/0,g=0,_=0,v=!0,y=document.visibilityState!==`hidden`,b=!1,E=``,D=n.createTexture();n.bindTexture(n.TEXTURE_2D,D),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_MIN_FILTER,n.LINEAR),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_MAG_FILTER,n.LINEAR),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_WRAP_S,n.CLAMP_TO_EDGE),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_WRAP_T,n.CLAMP_TO_EDGE);let O=e=>{e.paletteKey!==E&&(E=e.paletteKey,n.bindTexture(n.TEXTURE_2D,D),n.texImage2D(n.TEXTURE_2D,0,n.RGBA8,j,1,0,n.RGBA,n.UNSIGNED_BYTE,de(e.colors)))},A=(e,t,r)=>{let i=n.createTexture();n.bindTexture(n.TEXTURE_2D,i),n.texImage2D(n.TEXTURE_2D,0,r===2?n.RG16F:n.R16F,e,t,0,r===2?n.RG:n.RED,n.HALF_FLOAT,null),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_MIN_FILTER,n.LINEAR),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_MAG_FILTER,n.LINEAR),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_WRAP_S,n.CLAMP_TO_EDGE),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_WRAP_T,n.CLAMP_TO_EDGE);let a=n.createFramebuffer();return n.bindFramebuffer(n.FRAMEBUFFER,a),n.framebufferTexture2D(n.FRAMEBUFFER,n.COLOR_ATTACHMENT0,n.TEXTURE_2D,i,0),n.clearColor(0,0,0,0),n.clear(n.COLOR_BUFFER_BIT),{texture:i,framebuffer:a}},M=()=>{Object.keys(c).forEach(e=>{n.deleteTexture(c[e].texture),n.deleteFramebuffer(c[e].framebuffer),delete c[e]})},N=()=>{let r=k.current,i=e.getBoundingClientRect(),a=Math.max(1,i.width),l=Math.max(1,i.height),u=Math.min(window.devicePixelRatio||1,r.maxRatio,Math.sqrt(ee/(a*l))),d=Math.max(1,Math.round(a*u)),f=Math.max(1,Math.round(l*u));(t.width!==d||t.height!==f)&&(t.width=d,t.height=f),o.width=a,o.height=l;let p=r.resolution*.5,m=p*Math.min(1,Math.sqrt(te/(a*l*p*p))),h=F(Math.round(a*m),16,1024),g=F(Math.round(l*m),16,1024);(h!==s.width||g!==s.height)&&(M(),s.width=h,s.height=g,c.velocity=A(h,g,2),c.velocityNext=A(h,g,2),c.divergence=A(h,g,1),c.pressure=A(h,g,1),c.pressureNext=A(h,g,1),n.bindFramebuffer(n.FRAMEBUFFER,null))},P=(e,t)=>{let n=c[e];c[e]=c[t],c[t]=n},I=(e,t,r)=>{n.activeTexture(n.TEXTURE0+e),n.bindTexture(n.TEXTURE_2D,t),n.uniform1i(r,e)},L=(e,t,r)=>{n.useProgram(e.program),n.uniform2f(e.uniforms.uTexel,1/s.width,1/s.height),r(e.uniforms),n.bindFramebuffer(n.FRAMEBUFFER,t?t.framebuffer:null),n.drawArrays(n.TRIANGLES,0,3)},R=(e,t)=>{n.viewport(0,0,s.width,s.height);let i=+!!e.walls;f.forEach(e=>{L(r.splat,c.velocityNext,t=>{I(0,c.velocity.texture,t.uVelocity),n.uniform2f(t.uSize,o.width,o.height),n.uniform4f(t.uSegment,e.ax,e.ay,e.bx,e.by),n.uniform2f(t.uForce,e.vx,e.vy),n.uniform1f(t.uRadius,e.radius)}),P(`velocity`,`velocityNext`)}),f.length=0;let a=Math.ceil(e.viscosity*4);for(let t=0;t<a;t++)L(r.smooth,c.velocityNext,r=>{I(0,c.velocity.texture,r.uVelocity),n.uniform1f(r.uAmount,Math.min(1,e.viscosity*4-t)*.9)}),P(`velocity`,`velocityNext`);L(r.divergence,c.divergence,e=>{I(0,c.velocity.texture,e.uVelocity),n.uniform1f(e.uWalls,i)});for(let e=0;e<ne;e++)L(r.pressure,c.pressureNext,e=>{I(0,c.pressure.texture,e.uPressure),I(1,c.divergence.texture,e.uDivergence),n.uniform1f(e.uWalls,i)}),P(`pressure`,`pressureNext`);L(r.project,c.velocityNext,e=>{I(0,c.pressure.texture,e.uPressure),I(1,c.velocity.texture,e.uVelocity),n.uniform1f(e.uWalls,i)}),P(`velocity`,`velocityNext`),L(r.advect,c.velocityNext,r=>{I(0,c.velocity.texture,r.uVelocity),n.uniform2f(r.uStep,t/o.width,t/o.height),n.uniform1f(r.uKeep,ue(e.persistence,t)),n.uniform1f(r.uWalls,i)}),P(`velocity`,`velocityNext`)},fe=e=>{n.viewport(0,0,t.width,t.height),L(r.display,null,t=>{I(0,c.velocity.texture,t.uVelocity),I(1,D,t.uPalette),n.uniform2f(t.uSimSize,s.width,s.height),n.uniform1f(t.uSpeedScale,1.25*e.intensity/(.84*Math.max(o.width,o.height))),n.uniform1f(t.uLight,+!!e.light),n.uniform4f(t.uBackground,e.background[0],e.background[1],e.background[2],e.background[3])})},pe=e=>{let t=.62*Math.sin(e*.83+1.3)+.38*Math.sin(e*1.71+.4),n=.6*Math.sin(e*1.07+2.1)+.4*Math.cos(e*.61+.7);return[(.5+.41*t)*o.width,(.5+.41*n)*o.height]},B=e=>{let t=1-(1-F(e/1.4,0,1))**3,n=-.6+t*3.6,r=.08+.3*t;return[(.5+Math.cos(n)*r*1.1)*o.width,(.5+Math.sin(n)*r*(o.width/o.height)*.75)*o.height]},V=(e,t,n,r,i)=>{f.push({ax:e[0],ay:e[1],bx:t[0],by:t[1],vx:F((t[0]-e[0])/n*r,-6e3,6e3),vy:F((t[1]-e[1])/n*r,-6e3,6e3),radius:i})},H=e=>{if(g=0,b)return;let t=k.current;O(t);let r=F((e-_)/1e3||0,0,1/30);_=Math.max(_,e);let o=Math.min(1,r*60),s=e-h>t.autoResumeDelay&&!l.inside;if(d.active&&r>0){let e=B(d.time);d.time+=r;let n=Math.sin(Math.min(1,d.time/1.4)*Math.PI);V(e,B(d.time),r,.2*n,t.radius),m=1,d.time>1.4&&(d.active=!1)}else if(t.autoDemo&&!i&&s&&r>0){u.ramp=Math.min(1,u.ramp+r/.8),u.phase+=r*t.autoSpeed*1.6;let e=pe(u.phase);if(u.ready){let n=.3+.7*(.5+.5*Math.sin(u.phase*2.6))**2,i=t.force/20*.45*t.autoIntensity*u.ramp*u.ramp*n*o;V([u.x,u.y],e,r,i,t.radius)}u.x=e[0],u.y=e[1],u.ready=!0,m=1}else u.ramp=0;if(l.moved&&r>0){l.moved=!1;let n=Math.max(e-l.last,8)/1e3;V([l.fromX,l.fromY],[l.x,l.y],n,t.force/20*.15*o,t.radius),l.fromX=l.x,l.fromY=l.y,l.last=e,m=1}let c=p.shift();c&&f.push(c),n.bindVertexArray(a),n.disable(n.BLEND),r>0&&R(t,r),fe(t),m*=ue(t.persistence,r),(d.active||t.autoDemo&&!i||m>.002||p.length>0||l.moved)&&v&&y&&(g=requestAnimationFrame(H))},U=()=>{!g&&!b&&v&&y&&(_=performance.now(),g=requestAnimationFrame(H))};C.current=()=>{N(),U()};let W=t=>{let n=e.getBoundingClientRect();return{x:t.clientX-n.left,y:n.bottom-t.clientY,inside:t.clientX>=n.left&&t.clientX<=n.right&&t.clientY>=n.top&&t.clientY<=n.bottom}},G=e=>{let t=W(e);if(l.inside=t.inside,!t.inside){l.ready=!1;return}h=performance.now(),d.active=!1,l.ready||=(l.fromX=t.x,l.fromY=t.y,l.x=t.x,l.y=t.y,l.last=h,!0);let n=t.x-l.x,r=t.y-l.y;Math.hypot(n,r)>.5&&(l.dx=l.dx*.7+n*.3,l.dy=l.dy*.7+r*.3),l.x=t.x,l.y=t.y,l.moved=!0,U()},K=e=>{let t=k.current,n=W(e);if(!n.inside||(h=performance.now(),!t.clickBurst||i))return;let r=Math.hypot(l.dx,l.dy)>1?Math.atan2(l.dy,l.dx):Math.random()*Math.PI*2,a=Math.cos(r),o=Math.sin(r),s=t.radius*.5,c=1400*(t.force/20);p.push({ax:n.x-a*s,ay:n.y-o*s,bx:n.x+a*s,by:n.y+o*s,vx:a*c,vy:o*c,radius:t.radius*.9}),p.length>4&&p.shift(),m=1,U()},q=()=>{l.inside=!1,l.ready=!1},J=e=>{e.pointerType!==`mouse`&&q()};k.current.interactive&&(window.addEventListener(`pointermove`,G,{passive:!0}),window.addEventListener(`pointerdown`,K,{passive:!0}),window.addEventListener(`pointerup`,J,{passive:!0}),window.addEventListener(`pointercancel`,J,{passive:!0}),document.documentElement.addEventListener(`pointerleave`,q));let Y=e=>{e.preventDefault(),b=!0,cancelAnimationFrame(g),g=0},X=()=>T(e=>e+1);t.addEventListener(`webglcontextlost`,Y),t.addEventListener(`webglcontextrestored`,X);let Z=new ResizeObserver(()=>{N(),U()});Z.observe(e);let Q=new IntersectionObserver(e=>{v=e.some(e=>e.isIntersecting),U()});Q.observe(e);let $=()=>{y=document.visibilityState!==`hidden`,U()};return document.addEventListener(`visibilitychange`,$),N(),U(),()=>{cancelAnimationFrame(g),C.current=null,Z.disconnect(),Q.disconnect(),k.current.interactive&&(window.removeEventListener(`pointermove`,G),window.removeEventListener(`pointerdown`,K),window.removeEventListener(`pointerup`,J),window.removeEventListener(`pointercancel`,J),document.documentElement.removeEventListener(`pointerleave`,q)),document.removeEventListener(`visibilitychange`,$),t.removeEventListener(`webglcontextlost`,Y),t.removeEventListener(`webglcontextrestored`,X),n.isContextLost()||(M(),n.deleteTexture(D),n.deleteVertexArray(a),Object.values(r).forEach(e=>n.deleteProgram(e.program)))}},[w]),(0,A.jsx)(`div`,{ref:x,className:`liquid-ether${v?` ${v}`:``}`,style:b,children:(0,A.jsx)(`canvas`,{ref:S,className:`liquid-ether__canvas`,"aria-hidden":`true`})})};function VivicOriginalAtmosphere({theme:e,palette:t,paused:n=!1,className:r=`absolute inset-0`,layer:i,motionMode:a=`subtle`,intensity:o=.55,phase:s=`idle`,speed:atelierSpeed=1,customColors:atelierColors}){let{ref:c,visible:l}=k(),u=O(),d=n||!!u,f=m(a),_=h(o),v=!d&&l&&f!==`off`&&_>0,b=f===`vivid`,x=atelierColors?.enabled?[atelierColors.base,atelierColors.glow1,atelierColors.glow2,atelierColors.accent]:g[t].colors,[S,C]=(0,y.useState)(null);(0,y.useEffect)(()=>{if(!v){C(null);return}let e,t=t=>{let n=t.detail;if(!n||![`saved`,`transfer`,`arrange`,`undo`,`redo`].includes(n.kind))return;let r=c.current?.getBoundingClientRect(),i=n.point&&r?{x:n.point.x-r.left,y:n.point.y-r.top}:n.point;clearTimeout(e),C(e=>({...n,point:i,sequence:(e?.sequence??0)+1})),e=setTimeout(()=>C(null),1400)};return window.addEventListener(p,t),()=>{clearTimeout(e),window.removeEventListener(p,t)}},[v]);let w={"--space-light-strength":_,background:`radial-gradient(ellipse 70% 60% at 22% 48%, ${x[1]}aa, transparent 72%), radial-gradient(ellipse 60% 55% at 76% 40%, ${x[2]}99, transparent 70%), radial-gradient(ellipse 50% 40% at 52% 72%, ${x[3]}66, transparent 70%), ${x[0]}`};return(0,A.jsxs)(`div`,{ref:c,className:`hark-canvas-backdrop pointer-events-none overflow-hidden ${r}`,"aria-hidden":`true`,style:w,"data-vivic-layer":i,"data-vivic-atmosphere":t,"data-vivic-atmosphere-theme":e,"data-reduced-motion":d||void 0,"data-space-motion":f,"data-space-phase":s,"data-space-running":v,children:[(0,A.jsx)(fe,{className:`hark-liquid-ether`,style:{position:`absolute`,inset:0,width:`100%`,height:`100%`},colors:atelierColors?.enabled?[atelierColors.glow1,atelierColors.glow2,atelierColors.accent]:[...g[t].swatch],intensity:v?_*(b?1.3:.85):0,mouseForce:v?b?26:9:0,cursorSize:b?140:96,persistence:b?.88:.8,viscosity:b?.04:.12,resolution:.42,bounceEdges:!0,clickBurst:!1,interactive:!1,autoDemo:v,autoSpeed:(b?.62:.22)*atelierSpeed,autoIntensity:b?2:.65,autoResumeDelay:1200,intro:v&&b,lightMode:e===`light`,backgroundColor:`transparent`,maxDevicePixelRatio:1.5}),(0,A.jsx)(`div`,{className:`hark-space-focus`}),(0,A.jsx)(`div`,{className:`hark-space-activity`}),S&&v&&(0,A.jsx)(`div`,{className:`hark-space-receipt`,"data-space-receipt":S.kind,"data-space-receipt-anchor":S.point?`point`:void 0,style:S.point?{"--space-receipt-x":`${S.point.x}px`,"--space-receipt-y":`${S.point.y}px`}:void 0},S.sequence)]})}function pe(props){return(0,A.jsx)(VivicAtelierAtmosphere,{...props,renderOriginal:overrides=>(0,A.jsx)(VivicOriginalAtmosphere,overrides)})}var B={done:{accent:`success`,glow:.7,hueRotate:0,intensity:.4,motif:`ping`,pulseSeconds:.65,reactivity:0,saturation:1,scale:1.1,speed:.8,tumble:.02,turbulence:.08},error:{accent:`danger`,glow:.25,hueRotate:0,intensity:.5,motif:`fault`,pulseSeconds:.9,reactivity:0,saturation:.3,scale:.96,speed:1,tumble:0,turbulence:.55},idle:{accent:null,glow:.15,hueRotate:0,intensity:.3,motif:`breathe`,pulseSeconds:4.5,reactivity:0,saturation:.75,scale:.94,speed:.6,tumble:.012,turbulence:.14},listening:{accent:null,glow:.6,hueRotate:0,intensity:.75,motif:`receive`,pulseSeconds:1.6,reactivity:1,saturation:1.05,scale:1.06,speed:1,tumble:.03,turbulence:.42},streaming:{accent:null,glow:.45,hueRotate:-10,intensity:.6,motif:`pulse`,pulseSeconds:1.25,reactivity:.6,saturation:1,scale:1.02,speed:1.4,tumble:.06,turbulence:.5},thinking:{accent:null,glow:.35,hueRotate:18,intensity:1,motif:`scan`,pulseSeconds:1.1,reactivity:.15,saturation:1,scale:1,speed:2.4,tumble:.14,turbulence:.95}},V=e=>B[e??`idle`]??B.idle,H=e=>typeof e==`object`&&!!e&&`get`in e,U=e=>{let t=b(0),n=typeof e==`number`?e:null;return(0,y.useEffect)(()=>{n!==null&&t.set(n)},[n,t]),H(e)?e:t},W=50,G=30,K=100,q=.008,J=1,Y=.015,X=4,Z=.004,Q=1.2,$=.008,me=1.5,he=.004,ge=.05,_e=.008,ve=.1,ye=.004,be=.5,xe=.008,Se=2,Ce=`0%`,we=`5%`,Te=`15%`,Ee=`25%`,De=1.1,Oe=1.2,ke=1.3,Ae=.45,je=.12,Me=[0,-3,3,0],Ne=.18,Pe=[.645,.045,.355,1],Fe=.28,Ie=.7,Le=.06,Re=1.5,ze=12,Be=[1,1.035,1],Ve=5.5,He={bounce:.1,duration:.25,type:`spring`},Ue=({size:e=`192px`,className:t,colors:n,animationDuration:r=20,amplitude:i,state:a=`idle`,reducedMotion:o=!1})=>{let s=f()||o,c=U(i),u=V(a),d={bg:`oklch(92% 0.03 300)`,c1:`oklch(68% 0.21 350)`,c2:`oklch(70% 0.18 210)`,c3:`oklch(66% 0.2 285)`,c4:`oklch(72% 0.19 325)`,...n},p=d.c2,m=Number.parseInt(e.replace(`px`,``),10),h=m<W?Math.max(m*q,J):Math.max(m*Y,X),g=m<W?Math.max(m*Z,Q):Math.max(m*$,me),v=m<W?Math.max(m*he,ge):Math.max(m*_e,ve),y=m<W?Math.max(m*ye,be):Math.max(m*xe,Se),b=(e=>e<G?Ce:e<W?we:e<K?Te:Ee)(m),x=(e=>e<G?De:e<W?Math.max(g*Oe,ke):g)(m),S=s?0:u.reactivity,w=C(c,e=>{let t=1-e*S*Ae;return`${h*t}px`}),T=C(c,e=>u.scale+e*S*je),E=s?r:r/u.speed,D=Math.max(m*Le,Re),O=ze/(1+u.speed)*2;return(0,A.jsxs)(l.div,{animate:s?{scale:1,x:0}:a===`error`?{scale:1,x:Me}:u.motif===`breathe`?{scale:Be,x:0}:{scale:1,x:0},className:_(`relative`,t),"data-orb-reduced-motion":s||void 0,style:{"--orb-size":e,height:e,width:e},transition:s?{duration:0}:a===`error`?{duration:Ne,ease:Pe}:u.motif===`breathe`?{duration:Ve,ease:Pe,repeat:1/0}:He,children:[(0,A.jsx)(l.div,{animate:{opacity:u.glow*Ie},className:`absolute rounded-full`,style:{background:`radial-gradient(circle at 50% 50%, ${p} 0%, transparent 64%)`,filter:`blur(calc(var(--orb-size) * ${Fe}))`,inset:`-12%`},transition:s?{duration:0}:He}),(0,A.jsxs)(l.div,{className:`siri-orb`,style:{"--animation-duration":`${E}s`,"--bg":d.bg,"--blur-amount":w,"--c1":d.c1,"--c2":d.c2,"--c3":d.c3,"--c4":d.c4,"--contrast-amount":x,"--dot-size":`${v}px`,"--drift-duration":`${O}s`,"--mask-radius":b,"--rim":`${D}px`,"--shadow-spread":`${y}px`,filter:`saturate(${u.saturation}) hue-rotate(${u.hueRotate}deg)`,height:`100%`,scale:T,width:`100%`},children:[(0,A.jsx)(`span`,{"aria-hidden":`true`,className:`siri-orb-layer siri-orb-sheen`}),(0,A.jsx)(`span`,{"aria-hidden":`true`,className:`siri-orb-layer siri-orb-rim`}),(0,A.jsx)(`style`,{children:`
        @property --angle {
          syntax: "<angle>";
          inherits: false;
          initial-value: 0deg;
        }

        .siri-orb {
          display: grid;
          grid-template-areas: "stack";
          overflow: hidden;
          border-radius: 50%;
          position: relative;
          isolation: isolate;
        }

        [data-orb-reduced-motion="true"] .siri-orb::before,
        [data-orb-reduced-motion="true"] .siri-orb::after,
        [data-orb-reduced-motion="true"] .siri-orb > .siri-orb-layer {
          animation: none !important;
        }

        .siri-orb::before,
        .siri-orb::after,
        .siri-orb > .siri-orb-layer {
          content: "";
          display: block;
          grid-area: stack;
          width: 100%;
          height: 100%;
          border-radius: 50%;
        }

        /* Glassy highlight that drifts, so the sheen never sits still enough to
           read as a printed-on gradient. */
        .siri-orb-sheen {
          background:
            radial-gradient(circle at 30% 24%, hsl(0 0% 100% / 0.32), transparent 34%),
            radial-gradient(circle at 72% 80%, hsl(0 0% 100% / 0.07), transparent 48%);
          mix-blend-mode: screen;
          animation: siri-drift var(--drift-duration) ease-in-out infinite alternate;
        }

        /* Lit top edge, shaded bottom, thin inner ring. */
        .siri-orb-rim {
          box-shadow:
            inset 0 0 0 1px hsl(0 0% 100% / 0.16),
            inset 0 calc(var(--rim) * 1) calc(var(--rim) * 2) hsl(0 0% 100% / 0.22),
            inset 0 calc(var(--rim) * -1.2) calc(var(--rim) * 2.4) hsl(0 0% 0% / 0.4);
          pointer-events: none;
        }

        @keyframes siri-drift {
          0% { transform: translate(-6%, -4%) scale(1.05); }
          100% { transform: translate(7%, 6%) scale(1.12); }
        }

        .siri-orb::before {
          background:
            conic-gradient(
              from calc(var(--angle) * 2) at 25% 70%,
              var(--c3),
              transparent 20% 80%,
              var(--c3)
            ),
            conic-gradient(
              from calc(var(--angle) * 2) at 45% 75%,
              var(--c2),
              transparent 30% 60%,
              var(--c2)
            ),
            conic-gradient(
              from calc(var(--angle) * -3) at 80% 20%,
              var(--c1),
              transparent 40% 60%,
              var(--c1)
            ),
            conic-gradient(
              from calc(var(--angle) * 1.5) at 60% 35%,
              var(--c4),
              transparent 25% 75%,
              var(--c4)
            ),
            conic-gradient(
              from calc(var(--angle) * 2) at 15% 5%,
              var(--c2),
              transparent 10% 90%,
              var(--c2)
            ),
            conic-gradient(
              from calc(var(--angle) * 1) at 20% 80%,
              var(--c1),
              transparent 10% 90%,
              var(--c1)
            ),
            conic-gradient(
              from calc(var(--angle) * -2) at 85% 10%,
              var(--c3),
              transparent 20% 80%,
              var(--c3)
            );
          box-shadow: inset var(--bg) 0 0 var(--shadow-spread)
            calc(var(--shadow-spread) * 0.2);
          /* The saturate() pass is what keeps the colour alive after the blur
             and the overlaid dot pattern have both eaten into it. */
          filter: blur(var(--blur-amount)) contrast(var(--contrast-amount))
            saturate(1.4);
          animation: rotate var(--animation-duration) linear infinite;
        }

        .siri-orb::after {
          background-image: radial-gradient(
            circle at center,
            var(--bg) var(--dot-size),
            transparent var(--dot-size)
          );
          background-size: calc(var(--dot-size) * 2) calc(var(--dot-size) * 2);
          backdrop-filter: blur(calc(var(--blur-amount) * 2))
            contrast(calc(var(--contrast-amount) * 2));
          mix-blend-mode: overlay;
        }

        /* Apply mask only when radius is greater than 0 */
        .siri-orb[style*="--mask-radius: 0%"]::after {
          mask-image: none;
        }

        .siri-orb:not([style*="--mask-radius: 0%"])::after {
          mask-image: radial-gradient(
            black var(--mask-radius),
            transparent 75%
          );
        }

        @keyframes rotate {
          to {
            --angle: 360deg;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .siri-orb::before,
          .siri-orb-sheen {
            animation: none;
          }
        }
      `})]})]})};export{O as i,pe as n,k as r,Ue as t};