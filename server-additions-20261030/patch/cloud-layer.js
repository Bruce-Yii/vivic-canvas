import { i as interop } from './rolldown-runtime-Dd_uD5pT.js';
import { t as reactModule } from './react-CQOZoUwg.js';
const React=interop(reactModule(),1);
export function CloudLayer(props){
 const canvas=React.useRef(null),renderer=React.useRef(null),current=React.useRef(props);current.current=props;
 React.useLayoutEffect(()=>{
  window.VivicCloudRenderer?.disposeSeed();
  if(canvas.current&&window.VivicCloudRenderer)renderer.current=window.VivicCloudRenderer.mount(canvas.current,current.current);
  return()=>{renderer.current?.dispose();renderer.current=null;};
 },[]);
 React.useLayoutEffect(()=>{renderer.current?.update(props);},[props.theme,props.palette,JSON.stringify(props.colors),props.customEnabled,props.speed,props.intensity,props.motionMode,props.paused]);
 return React.createElement('div',{className:'atelier-cloud-layer','data-cloud-theme':props.theme,'aria-hidden':true,style:{opacity:Number(props.intensity)>0?1:0}},React.createElement('canvas',{ref:canvas,className:'atelier-cloud-canvas'}));
}
