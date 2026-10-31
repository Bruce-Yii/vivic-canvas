/* Cloud shader: Vanta CLOUDS, Copyright 2020 Teng Bao (MIT). License included in cloud-effect-LICENSE.txt. */
(()=>{
'use strict';
if(window.VivicCloudRenderer)return;
const FRAGMENT="uniform vec2 iResolution;\nuniform vec2 iMouse;\nuniform float iTime;\nuniform sampler2D iTex;\n\nuniform float speed;\nuniform vec3 skyColor;\nuniform vec3 cloudColor;\nuniform vec3 cloudShadowColor;\nuniform vec3 sunColor;\nuniform vec3 sunlightColor;\nuniform vec3 sunGlareColor;\nuniform vec3 backgroundColor;\n\n// uniform vec4      iMouse;                // mouse pixel coords. xy: current (if MLB down), zw: click\n// uniform samplerXX iChannel0..3;          // input channel. XX = 2D/Cube\n\n\n// Volumetric clouds. It performs level of detail (LOD) for faster rendering\nfloat hash(float p) {\n  p = fract(p * 0.011);\n  p *= (p + 7.5);\n  p *= (p + p);\n  return fract(p);\n}\n\nfloat noise( vec3 x ){\n    // The noise function returns a value in the range -1.0f -> 1.0f\n    vec3 p = floor(x);\n    vec3 f = fract(x);\n    f       = f*f*(3.0-2.0*f);\n    float n = p.x + p.y*57.0 + 113.0*p.z;\n    return mix(mix(mix( hash(n+0.0  ), hash(n+1.0  ),f.x),\n                   mix( hash(n+57.0 ), hash(n+58.0 ),f.x),f.y),\n               mix(mix( hash(n+113.0), hash(n+114.0),f.x),\n                   mix( hash(n+170.0), hash(n+171.0),f.x),f.y),f.z);\n}\n\nconst float constantTime = 1000.;\nfloat map5( in vec3 p ){\n    vec3 speed1 = vec3(0.5,0.01,1.0) * 0.5 * speed;\n    vec3 q = p - speed1*(iTime + constantTime);\n    float f;\n    f  = 0.50000*noise( q ); q = q*2.02;\n    f += 0.25000*noise( q ); q = q*2.03;\n    f += 0.12500*noise( q ); q = q*2.01;\n    f += 0.06250*noise( q ); q = q*2.02;\n    f += 0.03125*noise( q );\n    return clamp( 1.5 - p.y - 2.0 + 1.75*f, 0.0, 1.0 );\n}\nfloat map4( in vec3 p ){\n    vec3 speed1 = vec3(0.5,0.01,1.0) * 0.5 * speed;\n    vec3 q = p - speed1*(iTime + constantTime);\n    float f;\n    f  = 0.50000*noise( q ); q = q*2.02;\n    f += 0.25000*noise( q ); q = q*2.03;\n    f += 0.12500*noise( q ); q = q*2.01;\n    f += 0.06250*noise( q );\n    return clamp( 1.5 - p.y - 2.0 + 1.75*f, 0.0, 1.0 );\n}\nfloat map3( in vec3 p ){\n    vec3 speed1 = vec3(0.5,0.01,1.0) * 0.5 * speed;\n    vec3 q = p - speed1*(iTime + constantTime);\n    float f;\n    f  = 0.50000*noise( q ); q = q*2.02;\n    f += 0.25000*noise( q ); q = q*2.03;\n    f += 0.12500*noise( q );\n    return clamp( 1.5 - p.y - 2.0 + 1.75*f, 0.0, 1.0 );\n}\nfloat map2( in vec3 p ){\n    vec3 speed1 = vec3(0.5,0.01,1.0) * 0.5 * speed;\n    vec3 q = p - speed1*(iTime + constantTime);\n    float f;\n    f  = 0.50000*noise( q ); q = q*2.02;\n    f += 0.25000*noise( q );\n    return clamp( 1.5 - p.y - 2.0 + 1.75*f, 0.0, 1.0 );\n}\n\nvec3 sundir = normalize( vec3(-1.0,0.0,-1.0) );\n\nvec4 integrate( in vec4 sum, in float dif, in float den, in vec3 bgcol, in float t ){\n    // lighting\n    vec3 lin = cloudColor*1.4 + sunlightColor*dif;\n    vec4 col = vec4( mix( vec3(1.0,0.95,0.8), cloudShadowColor, den ), den );\n    col.xyz *= lin;\n    col.xyz = mix( col.xyz, bgcol, 1.0-exp(-0.003*t*t) );\n    // front to back blending\n    col.a *= 0.4;\n    col.rgb *= col.a;\n    return sum + col*(1.0-sum.a);\n}\n\n#define MARCH(STEPS,MAPLOD) for(int i=0; i<STEPS; i++) { vec3  pos = ro + t*rd; if( pos.y<-3.0 || pos.y>2.0 || sum.a > 0.99 ) break; float den = MAPLOD( pos ); if( den>0.01 ) { float dif = clamp((den - MAPLOD(pos+0.3*sundir))/0.6, 0.0, 1.0 ); sum = integrate( sum, dif, den, bgcol, t ); } t += max(0.075,0.02*t); }\n\nvec4 raymarch( in vec3 ro, in vec3 rd, in vec3 bgcol, in ivec2 px ){\n    vec4 sum = vec4(0.0);\n\n    float t = 0.0;\n\n    MARCH(20,map5);\n    MARCH(25,map4);\n    MARCH(30,map3);\n    MARCH(40,map2);\n\n    return clamp( sum, 0.0, 1.0 );\n}\n\nmat3 setCamera( in vec3 ro, in vec3 ta, float cr ){\n    vec3 cw = normalize(ta-ro);\n    vec3 cp = vec3(sin(cr), cos(cr),0.0);\n    vec3 cu = normalize( cross(cw,cp) );\n    vec3 cv = normalize( cross(cu,cw) );\n    return mat3( cu, cv, cw );\n}\n\nvec4 render( in vec3 ro, in vec3 rd, in ivec2 px ){\n    // background sky\n    float sun = clamp( dot(sundir,rd), 0.0, 1.0 );\n    vec3 col = skyColor - rd.y*0.2*vec3(1.0,0.5,1.0) + 0.15*0.5;\n    col += 0.2*sunColor*pow( sun, 8.0 );\n\n    // clouds\n    vec4 res = raymarch( ro, rd, col, px );\n    col = col*(1.0-res.w) + res.xyz;\n\n    // sun glare\n    col += 0.2*sunGlareColor*pow( sun, 3.0 );\n\n    return vec4( col, 1.0 );\n}\n\nvoid main(){\n    vec2 p = (-iResolution.xy + 2.0*gl_FragCoord.xy)/ iResolution.y;\n\n    vec2 m = iMouse.xy/iResolution.xy;\n    m.y = (1.0 - m.y) * 0.33 + 0.28; // camera height\n\n    m.x *= 0.25;\n    m.x += sin(iTime * 0.1 + 3.1415) * 0.25 + 0.25;\n\n    // camera\n    vec3 ro = 4.0*normalize(vec3(sin(3.0*m.x), 0.4*m.y, cos(3.0*m.x))); // origin\n    vec3 ta = vec3(0.0, 0.25, 0.0);\n    mat3 ca = setCamera( ro, ta, 0.0 );\n    // ray\n    vec3 rd = ca * normalize( vec3(p.xy,1.5));\n\n    gl_FragColor = render( ro, rd, ivec2(gl_FragCoord-0.5) );\n}\n";
const VERTEX='attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}';
const handles=new WeakMap();
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
// Match THREE.Color's sRGB-to-linear conversion used by the reference Vanta renderer.
const rgb=hex=>[1,3,5].map(i=>{const c=parseInt(hex.slice(i,i+2),16)/255;return c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4);});
const mix=(a,b,t)=>a.map((x,i)=>x*(1-t)+b[i]*t);
function colors(config){
 const c=config.colors.map(rgb);
 if(config.customEnabled)return{sky:c[0],cloud:c[1],shadow:c[2],sun:c[3]};
 if(config.theme==='dark')return{sky:mix(c[0],c[1],.35),cloud:mix(c[1],[.55,.6,.7],.18),shadow:c[0],sun:mix(c[2],[.7,.65,.8],.25)};
 if(config.palette==='milk')return{sky:rgb('#c8dcee'),cloud:[1,1,1],shadow:rgb('#7698c2'),sun:rgb('#f4e9d2')};
 return{sky:mix(c[1],c[0],.25),cloud:mix([1,1,1],c[2],.12),shadow:mix(c[3],c[1],.3),sun:mix([1,.97,.91],c[2],.18)};
}
function mount(canvas,config){
 if(handles.has(canvas)){const old=handles.get(canvas);old.update(config);return old;}
 let current={...config},gl=canvas.getContext('webgl',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:true,powerPreference:'low-power'}),program=null,buffer=null,vertex=null,fragment=null,raf=0,last=0,lastFrame=0,dead=false,frames=0;
 let time=Number(config.animationOffset||0)/1000;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const running=()=>!dead&&!document.hidden&&!reduced.matches&&!current.paused&&current.motionMode!=='off'&&Number(current.intensity)>0;
 const fail=error=>{canvas.dataset.cloudRenderer='fallback';canvas.style.opacity='0';if(error)console.warn('[Vivic cloud background]',error.message||error);};
 const compile=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(s);gl.deleteShader(s);throw Error(message);}return s;};
 let uniforms={};
 function init(){
  vertex=compile(gl.VERTEX_SHADER,VERTEX);fragment=compile(gl.FRAGMENT_SHADER,'precision highp float;\n'+FRAGMENT);
  program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);const location=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,2,gl.FLOAT,false,0,0);
  for(const key of ['iResolution','iMouse','iTime','speed','skyColor','cloudColor','cloudShadowColor','sunColor','sunlightColor','sunGlareColor','backgroundColor'])uniforms[key]=gl.getUniformLocation(program,key);
  canvas.dataset.cloudRenderer='webgl';canvas.style.opacity=String(clamp(Number(current.intensity)/.28,0,1));
 }
 function resize(){
  if(dead||!gl||gl.isContextLost())return;
  const rect=canvas.parentElement?.getBoundingClientRect()||{width:innerWidth,height:innerHeight};
  // Same 480x480 pixel budget as the reference site; limit costly volumetric ray marching.
  const width=Math.max(1,rect.width),height=Math.max(1,rect.height),ratio=Math.min(.66,Math.sqrt(230400/(width*height)));
  const w=Math.max(1,Math.round(width*ratio)),h=Math.max(1,Math.round(height*ratio));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}gl.viewport(0,0,w,h);draw();
 }
 function draw(){
  if(dead||!gl||gl.isContextLost()||!program)return;
  gl.useProgram(program);const c=colors(current);gl.uniform2f(uniforms.iResolution,canvas.width,canvas.height);gl.uniform2f(uniforms.iMouse,canvas.width*.5,canvas.height*.5);gl.uniform1f(uniforms.iTime,time);gl.uniform1f(uniforms.speed,1);
  for(const [key,value]of Object.entries({skyColor:c.sky,cloudColor:c.cloud,cloudShadowColor:c.shadow,sunColor:c.sun,sunlightColor:c.sun,sunGlareColor:c.sun,backgroundColor:current.colors.map?rgb(current.colors[0]):c.sky}))gl.uniform3fv(uniforms[key],value);
  gl.drawArrays(gl.TRIANGLES,0,6);frames++;canvas.dataset.cloudFrames=String(frames);canvas.dataset.cloudTime=time.toFixed(3);canvas.dataset.cloudRunning=String(running());
 }
 function tick(now){raf=0;if(!running()){last=0;canvas.dataset.cloudRunning='false';return;}if(!last)last=now;const dt=Math.min((now-last)/1000,.1);last=now;time+=dt*clamp(Number(current.speed)||1,.25,2)*.45;if(now-lastFrame>=1000/24){lastFrame=now;draw();}raf=requestAnimationFrame(tick);}
 function schedule(){if(raf)cancelAnimationFrame(raf);raf=0;last=0;draw();if(running())raf=requestAnimationFrame(tick);}
 const observer=new ResizeObserver(resize);
 const visibility=()=>schedule();
 function dispose(){if(dead)return;dead=true;if(raf)cancelAnimationFrame(raf);observer.disconnect();document.removeEventListener('visibilitychange',visibility);reduced.removeEventListener('change',visibility);canvas.removeEventListener('webglcontextlost',lost);canvas.removeEventListener('webglcontextrestored',restored);if(gl&&!gl.isContextLost()){gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);}handles.delete(canvas);canvas.dataset.cloudRunning='false';}
 function lost(event){event.preventDefault();if(raf)cancelAnimationFrame(raf);raf=0;canvas.dataset.cloudRenderer='lost';}
 function restored(){if(dead)return;try{init();resize();schedule();}catch(error){fail(error);}}
 const handle={update(next){const old=current;current={...next};if(gl){canvas.style.opacity=String(clamp(Number(current.intensity)/.28,0,1));if(old.speed!==current.speed||old.paused!==current.paused||old.motionMode!==current.motionMode)schedule();else draw();}},dispose,getTime:()=>time,getFrames:()=>frames};
 handles.set(canvas,handle);
 if(!gl){fail();return handle;}
 try{init();observer.observe(canvas.parentElement||canvas);document.addEventListener('visibilitychange',visibility);reduced.addEventListener('change',visibility);canvas.addEventListener('webglcontextlost',lost);canvas.addEventListener('webglcontextrestored',restored);resize();schedule();}catch(error){fail(error);}
 canvas.__vivicCloudHandle=handle;return handle;
}
let seed=null;
function seedMount(){const config=window.__vivicInitialBackground,container=document.getElementById('vivic-background-seed');if(!config||config.effect!=='clouds'||!container)return;container.dataset.spaceEffect='clouds';let canvas=container.querySelector('canvas');if(!canvas){canvas=document.createElement('canvas');canvas.className='atelier-cloud-canvas';canvas.setAttribute('aria-hidden','true');container.append(canvas);}seed=mount(canvas,{...config,paused:true});}
window.VivicCloudRenderer={mount,colors,seed:seedMount,disposeSeed(){seed?.dispose();seed=null;}};
})();
