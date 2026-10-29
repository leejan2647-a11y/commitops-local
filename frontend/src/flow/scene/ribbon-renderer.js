// Small purpose-built renderer for the original evidence-aperture glTF. No scene library, texture
// downloads, environment baking, shadow pass, or main-thread shader compilation.
const vertex = `
attribute vec3 position;
attribute vec3 normal;
uniform vec2 rotation;
uniform float aspect;
uniform vec2 orbitRotation;
uniform vec2 trackRotation;
uniform vec3 orbitAxis;
uniform vec2 pointerTilt;
varying vec3 N;
varying vec3 V;
void main(){
  // Only the source pearl travels. The aperture stays readable and breathes slowly.
  vec3 p=position*orbitRotation.x+cross(orbitAxis,position)*orbitRotation.y+orbitAxis*dot(orbitAxis,position)*(1.0-orbitRotation.x);
  vec3 n=normal*orbitRotation.x+cross(orbitAxis,normal)*orbitRotation.y+orbitAxis*dot(orbitAxis,normal)*(1.0-orbitRotation.x);
  float c=trackRotation.x,s=trackRotation.y;
  p=vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);
  n=vec3(c*n.x+s*n.z,n.y,-s*n.x+c*n.z);
  c=rotation.x;s=rotation.y;
  p=vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);
  n=vec3(c*n.x+s*n.z,n.y,-s*n.x+c*n.z);
  c=pointerTilt.x;s=pointerTilt.y;
  p=vec3(p.x,c*p.y-s*p.z,s*p.y+c*p.z);
  n=vec3(n.x,c*n.y-s*n.z,s*n.y+c*n.z);
  float cp=0.9996629,sp=0.0259653;
  V=vec3(p.x,cp*p.y-sp*p.z,sp*p.y+cp*p.z-7.702597);
  N=vec3(n.x,cp*n.y-sp*n.z,sp*n.y+cp*n.z);
  gl_Position=vec4(3.171595*V.x/aspect,3.171595*V.y,-1.0050125*V.z-0.20050125,-V.z);
}`
const fragment = `
precision mediump float;
varying vec3 N;
varying vec3 V;
uniform vec4 color;
uniform float unlit;
// ACES fit/matrices adapted from three.js r180, MIT; see THIRD_PARTY_NOTICES.
// Retain the recovered exposure (1.1) without loading its scene renderer.
vec3 outputColor(vec3 value){
  mat3 inputMat=mat3(0.59719,0.07600,0.02840,0.35458,0.90834,0.13383,0.04823,0.01566,0.83777);
  mat3 outputMat=mat3(1.60475,-0.10208,-0.00327,-0.53108,1.10813,-0.07276,-0.07367,-0.00605,1.07602);
  vec3 v=inputMat*(value*(1.1/0.6));
  vec3 a=v*(v+0.0245786)-0.000090537;
  vec3 b=v*(0.983729*v+0.4329510)+0.238081;
  vec3 mapped=clamp(outputMat*(a/b),0.0,1.0);
  return mix(1.055*pow(mapped,vec3(1.0/2.4))-0.055,mapped*12.92,step(mapped,vec3(0.0031308)));
}
void main(){
  vec3 n=normalize(N);if(!gl_FrontFacing)n=-n;
  vec3 eye=normalize(-V);
  vec3 base=color.rgb;
  vec3 key=normalize(vec3(2.0,4.0,5.0));
  vec3 fill=normalize(vec3(-4.0,1.0,2.0));
  float diffuse=0.40+0.35*max(dot(n,key),0.0)+0.20*max(dot(n,fill),0.0);
  float sheen=pow(max(dot(n,normalize(key+eye)),0.0),42.0)*0.55;
  float rim=pow(1.0-abs(dot(n,eye)),3.0)*0.27;
  vec3 lit=base*diffuse+vec3(sheen)+vec3(0.77,0.86,0.96)*rim;
  gl_FragColor=vec4(outputColor(mix(lit,base,unlit)),color.a);
}`

function shader(gl, type, source) {
  const value = gl.createShader(type)
  gl.shaderSource(value, source); gl.compileShader(value)
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value))
  return value
}
function rotate(v, q) {
  const [x,y,z] = v, [qx,qy,qz,qw] = q
  const tx=2*(qy*z-qz*y), ty=2*(qz*x-qx*z), tz=2*(qx*y-qy*x)
  return [x+qw*tx+qy*tz-qz*ty,y+qw*ty+qz*tx-qx*tz,z+qw*tz+qx*ty-qy*tx]
}

async function loadMesh(gl) {
  const response = await fetch('/scenes/ribbon.glb')
  if (!response.ok) throw new Error('Evidence aperture geometry unavailable')
  const data = await response.arrayBuffer(), header = new DataView(data)
  const length = header.getUint32(12, true)
  const asset = JSON.parse(new TextDecoder().decode(new Uint8Array(data,20,length)))
  const binaryStart=28+length
  const values = (id) => {
    const acc=asset.accessors[id], view=asset.bufferViews[acc.bufferView]
    const offset=binaryStart+(view.byteOffset||0)+(acc.byteOffset||0)
    return acc.componentType===5126 ? new Float32Array(data,offset,acc.count*3) : new Uint16Array(data,offset,acc.count)
  }
  const buffer = (target, data) => { const value=gl.createBuffer();gl.bindBuffer(target,value);gl.bufferData(target,data,gl.STATIC_DRAW);return value }
  const meshes=[], groups=new Map()
  const root=asset.nodes[asset.scenes[asset.scene||0].nodes[0]]
  const ring=asset.nodes.find(node=>node.name==='Orbit')
  const axis=new Float32Array(rotate(rotate([0,0,1],ring.rotation),root.rotation))
  function visit(index, transforms) {
    const node=asset.nodes[index], chain=[node,...transforms]
    if(node.mesh!==undefined) for(const primitive of asset.meshes[node.mesh].primitives) {
      const pos=new Float32Array(values(primitive.attributes.POSITION)), norm=new Float32Array(values(primitive.attributes.NORMAL))
      for(let i=0;i<pos.length;i+=3) {
        let p=[pos[i],pos[i+1],pos[i+2]],n=[norm[i],norm[i+1],norm[i+2]]
        for(const transform of chain) {
          if(transform.rotation){p=rotate(p,transform.rotation);n=rotate(n,transform.rotation)}
          if(transform.translation)p=p.map((v,j)=>v+transform.translation[j])
        }
        pos.set(p,i);norm.set(n,i)
      }
      const indices=values(primitive.indices), material=asset.materials[primitive.material]
      // Bake static parts together by material once. Three ledger leaves do
      // not require separate draw calls or per-frame matrix/uniform work.
      const dynamic=node.name==='Orbit'||node.name==='Orbit marker'
      const key=dynamic?node.name:`material-${primitive.material}`
      let group=groups.get(key)
      if(!group){group={role:node.name,pos:[],norm:[],ids:[],material};groups.set(key,group)}
      const base=group.pos.length/3
      for(const value of pos)group.pos.push(value)
      for(const value of norm)group.norm.push(value)
      for(const value of indices)group.ids.push(value+base)
    }
    node.children?.forEach(child=>visit(child,chain))
  }
  asset.scenes[asset.scene||0].nodes.forEach(index=>visit(index,[]))
  for(const group of groups.values()){
    const material=group.material
    meshes.push({role:group.role,positions:buffer(gl.ARRAY_BUFFER,new Float32Array(group.pos)),normals:buffer(gl.ARRAY_BUFFER,new Float32Array(group.norm)),indices:buffer(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(group.ids)),count:group.ids.length,color:new Float32Array(material.pbrMetallicRoughness.baseColorFactor),unlit:!!material.extensions?.KHR_materials_unlit,blend:material.alphaMode==='BLEND'})
  }
  return {meshes,axis}
}

export async function createScene({canvas}) {
  const gl=canvas.getContext('webgl',{alpha:true,antialias:true,powerPreference:'low-power',premultipliedAlpha:true})
  if(!gl)throw new Error('WebGL unavailable; keep static ribbon')
  const program=gl.createProgram()
  const vs=shader(gl,gl.VERTEX_SHADER,vertex),fs=shader(gl,gl.FRAGMENT_SHADER,fragment)
  gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program)
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program))
  gl.deleteShader(vs);gl.deleteShader(fs)
  const {meshes,axis}=await loadMesh(gl)
  const positions=gl.getAttribLocation(program,'position'),normals=gl.getAttribLocation(program,'normal')
  const rotation=gl.getUniformLocation(program,'rotation'),aspect=gl.getUniformLocation(program,'aspect'),color=gl.getUniformLocation(program,'color'),unlit=gl.getUniformLocation(program,'unlit')
  const orbitRotation=gl.getUniformLocation(program,'orbitRotation'),trackRotation=gl.getUniformLocation(program,'trackRotation'),orbitAxis=gl.getUniformLocation(program,'orbitAxis'),pointerTilt=gl.getUniformLocation(program,'pointerTilt')
  gl.enable(gl.DEPTH_TEST);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA)
  gl.clearColor(0,0,0,0);gl.useProgram(program)
  let elapsed=0,angle=0,orbitAngle=0,offset=0,targetOffset=0,px=0,py=0,targetX=0,targetY=0
  const views=[0,22*Math.PI/180,-22*Math.PI/180]
  return {
    visible:false,
    setPointer(x,y){targetX=Math.max(-1,Math.min(1,x))*5*Math.PI/180;targetY=Math.max(-1,Math.min(1,y))*3*Math.PI/180},
    setView(index,immediate=false){targetOffset=views[index]??0;if(immediate)offset=targetOffset},
    reset(immediate=false){targetOffset=0;targetX=0;targetY=0;if(immediate){elapsed=0;angle=0;orbitAngle=0;offset=0;px=0;py=0}},
    resize(w,h,dpr){canvas.width=Math.max(1,Math.round(w*dpr));canvas.height=Math.max(1,Math.round(h*dpr));gl.viewport(0,0,canvas.width,canvas.height)},
    draw(delta){
      elapsed+=delta
      angle=Math.sin(elapsed*Math.PI*2/24)*5*Math.PI/180
      orbitAngle=elapsed*Math.PI*2/36
      const ease=1-Math.exp(-8*delta)
      px+=(targetX-px)*ease;py+=(targetY-py)*ease
      offset+=(targetOffset-offset)*(1-Math.exp(-5.6*delta))
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT)
      gl.uniform2f(rotation,Math.cos(angle+offset+px),Math.sin(angle+offset+px));gl.uniform1f(aspect,canvas.width/canvas.height)
      gl.uniform3fv(orbitAxis,axis);gl.uniform2f(pointerTilt,Math.cos(py),Math.sin(py))
      for(const mesh of meshes){
        const marker=mesh.role==='Orbit marker'
        gl.uniform2f(orbitRotation,marker?Math.cos(orbitAngle):1,marker?Math.sin(orbitAngle):0)
        gl.uniform2f(trackRotation,1,0)
        if(mesh.blend){gl.enable(gl.BLEND);gl.depthMask(false)}else{gl.disable(gl.BLEND);gl.depthMask(true)}
        gl.bindBuffer(gl.ARRAY_BUFFER,mesh.positions);gl.enableVertexAttribArray(positions);gl.vertexAttribPointer(positions,3,gl.FLOAT,false,0,0)
        gl.bindBuffer(gl.ARRAY_BUFFER,mesh.normals);gl.enableVertexAttribArray(normals);gl.vertexAttribPointer(normals,3,gl.FLOAT,false,0,0)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,mesh.indices);gl.uniform4fv(color,mesh.color);gl.uniform1f(unlit,mesh.unlit?1:0)
        gl.drawElements(gl.TRIANGLES,mesh.count,gl.UNSIGNED_SHORT,0)
      }
      gl.depthMask(true)
    },
  }
}
