(function(){var e=Object.defineProperty,t=(e,t,n)=>()=>{if(n)throw n[0];try{return e&&(t=e(e=0)),t}catch(e){throw n=[e],e}},n=(t,n)=>{let r={};for(var i in t)e(r,i,{get:t[i],enumerable:!0});return n||e(r,Symbol.toStringTag,{value:`Module`}),r},r=/* @__PURE__ */ n({createScene:()=>i});async function i({canvas:e}){let t=await fetch(`/scenes/globe.bin`);if(!t.ok)throw Error(`Globe geometry unavailable`);let n=await t.arrayBuffer(),r=new DataView(n),i=r.getUint32(0,!0),o=4+i*24,s=[];for(let e=0;e<i;e++){let t=4+e*24;s.push({start:r.getUint32(t,!0),count:r.getUint32(t+4,!0),x:r.getFloat32(t+8,!0),y:r.getFloat32(t+12,!0),z:r.getFloat32(t+16,!0),threshold:r.getFloat32(t+20,!0)})}let c=new Float32Array(n,o),l=e.getContext(`2d`,{alpha:!0});if(!l)throw Error(`Canvas unavailable`);let u=0,d=0,f=0,p=1,m=Math.cos(0),h=Math.sin(0);return{visible:!1,resize(t,n,r){d=t,f=n,p=r,e.width=Math.max(1,Math.round(d*p)),e.height=Math.max(1,Math.round(f*p)),l.setTransform(p,0,0,p,0,0)},draw(e){u+=e*1.5*a;let t=Math.cos(u),n=Math.sin(u),r=Math.min(d,f)*.45,i=d/2,o=f/2;l.clearRect(0,0,d,f),l.lineWidth=.6,l.strokeStyle=`rgba(197,208,218,1)`,l.beginPath();for(let e of s){if(m*(t*e.x-n*e.y)-h*e.z<e.threshold)continue;let a=0,s=0,u=0,d=!1;for(let f=e.start*3,p=(e.start+e.count)*3;f<p;f+=3){let e=c[f],p=c[f+1],g=c[f+2],_=t*e-n*p,v=n*e+t*p,y=m*g+h*_,b=m*_-h*g;if(b>=0){if(d&&u>=0)l.lineTo(i+v*r,o-y*r);else if(d){let e=u/(u-b),t=a+(v-a)*e,n=s+(y-s)*e,c=Math.hypot(t,n);l.moveTo(i+t/c*r,o-n/c*r),l.lineTo(i+v*r,o-y*r)}else l.moveTo(i+v*r,o-y*r)}else if(d&&u>=0){let e=u/(u-b),t=a+(v-a)*e,n=s+(y-s)*e,c=Math.hypot(t,n);l.lineTo(i+t/c*r,o-n/c*r)}a=v,s=y,u=b,d=!0}}l.stroke(),l.beginPath(),l.arc(i,o,r,0,Math.PI*2),l.lineWidth=1.5,l.strokeStyle=`rgba(197,208,218,0.8)`,l.stroke()}}}var a,o=t((()=>{a=Math.PI/180})),s=/* @__PURE__ */ n({createScene:()=>d});function c(e,t,n){let r=e.createShader(t);if(e.shaderSource(r,n),e.compileShader(r),!e.getShaderParameter(r,e.COMPILE_STATUS))throw Error(e.getShaderInfoLog(r));return r}function l(e,t){let[n,r,i]=e,[a,o,s,c]=t,l=2*(o*i-s*r),u=2*(s*n-a*i),d=2*(a*r-o*n);return[n+c*l+o*d-s*u,r+c*u+s*l-a*d,i+c*d+a*u-o*l]}async function u(e){let t=await fetch(`/scenes/ribbon.glb`);if(!t.ok)throw Error(`Evidence aperture geometry unavailable`);let n=await t.arrayBuffer(),r=new DataView(n).getUint32(12,!0),i=JSON.parse(new TextDecoder().decode(new Uint8Array(n,20,r))),a=28+r,o=e=>{let t=i.accessors[e],r=i.bufferViews[t.bufferView],o=a+(r.byteOffset||0)+(t.byteOffset||0);return t.componentType===5126?new Float32Array(n,o,t.count*3):new Uint16Array(n,o,t.count)},s=(t,n)=>{let r=e.createBuffer();return e.bindBuffer(t,r),e.bufferData(t,n,e.STATIC_DRAW),r},c=[],u=/* @__PURE__ */ new Map,d=i.nodes[i.scenes[i.scene||0].nodes[0]],f=i.nodes.find(e=>e.name===`Orbit`),p=new Float32Array(l(l([0,0,1],f.rotation),d.rotation));function m(e,t){let n=i.nodes[e],r=[n,...t];if(n.mesh!==void 0)for(let e of i.meshes[n.mesh].primitives){let t=new Float32Array(o(e.attributes.POSITION)),a=new Float32Array(o(e.attributes.NORMAL));for(let e=0;e<t.length;e+=3){let n=[t[e],t[e+1],t[e+2]],i=[a[e],a[e+1],a[e+2]];for(let e of r)e.rotation&&(n=l(n,e.rotation),i=l(i,e.rotation)),e.translation&&(n=n.map((t,n)=>t+e.translation[n]));t.set(n,e),a.set(i,e)}let s=o(e.indices),c=i.materials[e.material],d=n.name===`Orbit`||n.name===`Orbit marker`?n.name:`material-${e.material}`,f=u.get(d);f||(f={role:n.name,pos:[],norm:[],ids:[],material:c},u.set(d,f));let p=f.pos.length/3;for(let e of t)f.pos.push(e);for(let e of a)f.norm.push(e);for(let e of s)f.ids.push(e+p)}n.children?.forEach(e=>m(e,r))}i.scenes[i.scene||0].nodes.forEach(e=>m(e,[]));for(let t of u.values()){let n=t.material;c.push({role:t.role,positions:s(e.ARRAY_BUFFER,new Float32Array(t.pos)),normals:s(e.ARRAY_BUFFER,new Float32Array(t.norm)),indices:s(e.ELEMENT_ARRAY_BUFFER,new Uint16Array(t.ids)),count:t.ids.length,color:new Float32Array(n.pbrMetallicRoughness.baseColorFactor),unlit:!!n.extensions?.KHR_materials_unlit,blend:n.alphaMode===`BLEND`})}return{meshes:c,axis:p}}async function d({canvas:e}){let t=e.getContext(`webgl`,{alpha:!0,antialias:!0,powerPreference:`low-power`,premultipliedAlpha:!0});if(!t)throw Error(`WebGL unavailable; keep static ribbon`);let n=t.createProgram(),r=c(t,t.VERTEX_SHADER,f),i=c(t,t.FRAGMENT_SHADER,p);if(t.attachShader(n,r),t.attachShader(n,i),t.linkProgram(n),!t.getProgramParameter(n,t.LINK_STATUS))throw Error(t.getProgramInfoLog(n));t.deleteShader(r),t.deleteShader(i);let{meshes:a,axis:o}=await u(t),s=t.getAttribLocation(n,`position`),l=t.getAttribLocation(n,`normal`),d=t.getUniformLocation(n,`rotation`),m=t.getUniformLocation(n,`aspect`),h=t.getUniformLocation(n,`color`),g=t.getUniformLocation(n,`unlit`),_=t.getUniformLocation(n,`orbitRotation`),v=t.getUniformLocation(n,`trackRotation`),y=t.getUniformLocation(n,`orbitAxis`),b=t.getUniformLocation(n,`pointerTilt`);t.enable(t.DEPTH_TEST),t.blendFuncSeparate(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA,t.ONE,t.ONE_MINUS_SRC_ALPHA),t.clearColor(0,0,0,0),t.useProgram(n);let x=0,S=0,C=0,w=0,T=0,E=0,D=0,O=0,k=0,A=[0,22*Math.PI/180,-22*Math.PI/180];return{visible:!1,setPointer(e,t){O=Math.max(-1,Math.min(1,e))*5*Math.PI/180,k=Math.max(-1,Math.min(1,t))*3*Math.PI/180},setView(e,t=!1){T=A[e]??0,t&&(w=T)},reset(e=!1){T=0,O=0,k=0,e&&(x=0,S=0,C=0,w=0,E=0,D=0)},resize(n,r,i){e.width=Math.max(1,Math.round(n*i)),e.height=Math.max(1,Math.round(r*i)),t.viewport(0,0,e.width,e.height)},draw(n){x+=n,S=Math.sin(x*Math.PI*2/24)*5*Math.PI/180,C=x*Math.PI*2/36;let r=1-Math.exp(-8*n);E+=(O-E)*r,D+=(k-D)*r,w+=(T-w)*(1-Math.exp(-5.6*n)),t.clear(t.COLOR_BUFFER_BIT|t.DEPTH_BUFFER_BIT),t.uniform2f(d,Math.cos(S+w+E),Math.sin(S+w+E)),t.uniform1f(m,e.width/e.height),t.uniform3fv(y,o),t.uniform2f(b,Math.cos(D),Math.sin(D));for(let e of a){let n=e.role===`Orbit marker`;t.uniform2f(_,n?Math.cos(C):1,n?Math.sin(C):0),t.uniform2f(v,1,0),e.blend?(t.enable(t.BLEND),t.depthMask(!1)):(t.disable(t.BLEND),t.depthMask(!0)),t.bindBuffer(t.ARRAY_BUFFER,e.positions),t.enableVertexAttribArray(s),t.vertexAttribPointer(s,3,t.FLOAT,!1,0,0),t.bindBuffer(t.ARRAY_BUFFER,e.normals),t.enableVertexAttribArray(l),t.vertexAttribPointer(l,3,t.FLOAT,!1,0,0),t.bindBuffer(t.ELEMENT_ARRAY_BUFFER,e.indices),t.uniform4fv(h,e.color),t.uniform1f(g,+!!e.unlit),t.drawElements(t.TRIANGLES,e.count,t.UNSIGNED_SHORT,0)}t.depthMask(!0)}}}var f,p,m=t((()=>{f=`
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
}`,p=`
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
}`}));let h=/* @__PURE__ */ new Map,g=/* @__PURE__ */ new Map,_=!1,v=!1,y=0,b=0,x=1e3/24,S={starts:0,frames:0,maxDrawMs:0,errors:[]};function C(){y||_||v||![...h.values()].some(e=>e.visible)||(b=performance.now(),y=setTimeout(w,x))}function w(){if(y=0,_||v)return;let e=performance.now(),t=Math.min((e-b)/1e3,.1);b=e;let n=!1;for(let e of h.values()){if(!e.visible)continue;n=!0;let r=performance.now();e.draw(t),S.frames++,S.maxDrawMs=Math.max(S.maxDrawMs,performance.now()-r)}n&&(y=setTimeout(w,Math.max(0,x-(performance.now()-e))))}function T(){clearTimeout(y),y=0,b=0}self.onmessage=async({data:e})=>{if(e.type===`activity`){_=e.hidden,v=e.paused,v&&h.get(`ribbon`)?.setPointer?.(0,0),T(),C();return}if(e.type===`stats`){self.postMessage({type:`stats`,...S,scenes:[...h.keys()]});return}if(e.type===`init`){if(h.has(e.kind)||g.has(e.kind))return;g.set(e.kind,e);try{let t=await(e.kind===`globe`?await Promise.resolve().then(()=>(o(),r)):await Promise.resolve().then(()=>(m(),s))).createScene(e),n=g.get(e.kind);t.visible=n.visible,t.setView?.(n.viewIndex||0,v),t.resize(n.width,n.height,n.dpr),t.draw(0),h.set(e.kind,t),g.delete(e.kind),S.starts++,await new Promise(e=>typeof requestAnimationFrame==`function`?requestAnimationFrame(e):setTimeout(e,32)),self.postMessage({type:`ready`,kind:e.kind}),C()}catch(t){S.errors.push(String(t)),g.delete(e.kind),self.postMessage({type:`error`,kind:e.kind,message:String(t)})}return}let t=g.get(e.kind);t&&(e.type===`visibility`&&(t.visible=e.visible),e.type===`resize`&&Object.assign(t,{width:e.width,height:e.height,dpr:e.dpr}),e.type===`view`&&(t.viewIndex=e.index),e.type===`reset`&&(t.viewIndex=0));let n=h.get(e.kind);n&&(e.type===`pointer`&&(e.x===0&&e.y===0||!v&&!_&&n.visible)&&n.setPointer?.(e.x,e.y),e.type===`visibility`&&(n.visible=e.visible,T(),C()),e.type===`resize`&&(n.resize(e.width,e.height,e.dpr),n.visible&&!_&&n.draw(0)),e.type===`view`&&(n.setView?.(e.index,v),n.visible&&!_&&n.draw(0),C()),e.type===`reset`&&(n.reset?.(v),n.visible&&!_&&n.draw(0),C()))}})();