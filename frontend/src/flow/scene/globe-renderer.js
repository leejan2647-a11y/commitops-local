const radians=Math.PI/180
export async function createScene({canvas}) {
  const response=await fetch('/scenes/globe.bin')
  if(!response.ok)throw new Error('Globe geometry unavailable')
  const buffer=await response.arrayBuffer(),header=new DataView(buffer)
  const count=header.getUint32(0,true),offset=4+count*24
  const arcs=[]
  for(let i=0;i<count;i++){
    const record=4+i*24
    arcs.push({start:header.getUint32(record,true),count:header.getUint32(record+4,true),x:header.getFloat32(record+8,true),y:header.getFloat32(record+12,true),z:header.getFloat32(record+16,true),threshold:header.getFloat32(record+20,true)})
  }
  const points=new Float32Array(buffer,offset)
  const ctx=canvas.getContext('2d',{alpha:true})
  if(!ctx)throw new Error('Canvas unavailable')
  let longitude=0,w=0,h=0,dpr=1
  const phi=0,cp=Math.cos(phi),sp=Math.sin(phi)
  return {
    visible:false,
    resize(width,height,ratio){w=width;h=height;dpr=ratio;canvas.width=Math.max(1,Math.round(w*dpr));canvas.height=Math.max(1,Math.round(h*dpr));ctx.setTransform(dpr,0,0,dpr,0,0)},
    draw(delta){
      longitude+=delta*1.5*radians
      const c=Math.cos(longitude),s=Math.sin(longitude),scale=Math.min(w,h)*0.45,cx=w/2,cy=h/2
      ctx.clearRect(0,0,w,h)
      ctx.lineWidth=0.6;ctx.strokeStyle='rgba(197,208,218,1)'
      ctx.beginPath()
      for(const arc of arcs){
        // Conservative arc-cap hemisphere culling; large caps are never culled.
        if(cp*(c*arc.x-s*arc.y)-sp*arc.z < arc.threshold)continue
        let px=0,py=0,pz=0,previous=false
        for(let i=arc.start*3,end=(arc.start+arc.count)*3;i<end;i+=3){
          const x=points[i],y=points[i+1],z=points[i+2]
          const x0=c*x-s*y,vx=s*x+c*y,vy=cp*z+sp*x0,vz=cp*x0-sp*z
          if(vz>=0){
            if(previous&&pz>=0)ctx.lineTo(cx+vx*scale,cy-vy*scale)
            else if(previous){const t=pz/(pz-vz),ix=px+(vx-px)*t,iy=py+(vy-py)*t,n=Math.hypot(ix,iy);ctx.moveTo(cx+ix/n*scale,cy-iy/n*scale);ctx.lineTo(cx+vx*scale,cy-vy*scale)}
            else ctx.moveTo(cx+vx*scale,cy-vy*scale)
          }else if(previous&&pz>=0){const t=pz/(pz-vz),ix=px+(vx-px)*t,iy=py+(vy-py)*t,n=Math.hypot(ix,iy);ctx.lineTo(cx+ix/n*scale,cy-iy/n*scale)}
          px=vx;py=vy;pz=vz;previous=true
        }
      }
      ctx.stroke()
      ctx.beginPath();ctx.arc(cx,cy,scale,0,Math.PI*2);ctx.lineWidth=1.5;ctx.strokeStyle='rgba(197,208,218,0.8)';ctx.stroke()
    },
  }
}
