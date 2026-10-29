import source from './background-paths-data.json'

type Curve={points:Float32Array;width:number;opacity:number;phase:number;waveStart:number}
type Group={viewBox:number[];paths:Curve[]}
const FPS=24,INTERVAL=1000/FPS,MAX_PIXELS=2_000_000
const dash=[260,160]
const geometry=(groups:typeof source.desktop):Group[]=>groups.map(group=>({viewBox:group.viewBox,paths:group.paths.map((p,index)=>({points:new Float32Array(p.d.match(/-?\d+(?:\.\d+)?/g)!.map(Number)),width:p.width,opacity:p.opacity,phase:index*17,waveStart:Math.sin(index*.1)}))}))
// Coordinates are parsed once. Each frame uses two native cubic curves per line,
// with no SVG/DOM mutations, new paths, arrays or sampled spline tessellation.
const desktop=geometry(source.desktop),mobile=geometry(source.mobile)
let canvas:OffscreenCanvas|undefined,ctx:OffscreenCanvasRenderingContext2D|null=null,groups=desktop
let width=1,height=1,resizePending=false,active=false,ready=false,timer:ReturnType<typeof setTimeout>|undefined,last=0,time=0
function draw(){
 if(!ctx||!canvas)return
 if(resizePending){canvas.width=width;canvas.height=height;resizePending=false}
 ctx.resetTransform();ctx.clearRect(0,0,width,height)
 ctx.strokeStyle='#dbe7f3';ctx.lineCap='round';ctx.setLineDash(dash)
 for(let groupIndex=0;groupIndex<groups.length;groupIndex++){
  const group=groups[groupIndex],sx=width/group.viewBox[2],sy=height/group.viewBox[3]
  if(groupIndex===0)ctx.setTransform(sx,0,0,sy,0,0)
  else ctx.setTransform(-sx,0,0,-sy,width,height)
  const bendX=Math.sin(time*.23)*34,bendY=Math.sin(time*.18)*42
  for(let index=0;index<group.paths.length;index++){
   const curve=group.paths[index],p=curve.points,wave=(Math.sin(time*.32+index*.1)-curve.waveStart)*5
   const x=bendX+wave,y=bendY+wave
   ctx.globalAlpha=curve.opacity*(groupIndex===0?1:.75)
   ctx.lineWidth=curve.width;ctx.lineDashOffset=-(time*28+curve.phase)
   ctx.beginPath();ctx.moveTo(p[0],p[1])
   ctx.bezierCurveTo(p[2],p[3],p[4]+x*.55,p[5]+y*.55,p[6]+x,p[7]+y)
   ctx.bezierCurveTo(p[8]+x*.55,p[9]+y*.55,p[10],p[11],p[12],p[13])
   ctx.stroke()
  }
 }
 if(!ready){ready=true;self.postMessage({type:'ready'})}
}
function tick(){
 timer=undefined;if(!active)return
 const began=performance.now()
 time+=(began-last)/1000;last=began;draw()
 timer=setTimeout(tick,Math.max(0,INTERVAL-(performance.now()-began)))
}
function setActive(value:boolean){
 if(active===value)return
 active=value;clearTimeout(timer);timer=undefined
 if(active&&ctx){last=performance.now();tick()}
}
self.onmessage=(event:MessageEvent)=>{
 const message=event.data
 if(message.type==='init'){canvas=message.canvas;ctx=canvas!.getContext('2d',{alpha:true,desynchronized:true});if(!ctx)throw new Error('Background requires a 2D canvas context')}
 else if(message.type==='resize'&&canvas){
  const scale=Math.min(1,Math.sqrt(MAX_PIXELS/(message.width*message.height)))
  width=Math.max(1,Math.floor(message.width*scale));height=Math.max(1,Math.floor(message.height*scale))
  groups=message.mobile?mobile:desktop;resizePending=true
 }else if(message.type==='active')setActive(message.value)
}
