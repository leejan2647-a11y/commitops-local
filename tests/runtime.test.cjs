const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const {locations,ready,binaryFromTar,ASSETS}=require('../bin/runtime.cjs');
test('supported platforms have pinned SHA256 archive digests',()=>{assert.equal(Object.keys(ASSETS).length,6);for(const [name,digest]of Object.values(ASSETS)){assert.match(digest,/^[a-f0-9]{64}$/);assert.match(name,/^uv-/);}});
test('dependency upgrades get a separate runtime instead of rewriting a running interpreter',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'commitops-runtime-'));
 try{fs.writeFileSync(path.join(directory,'requirements.txt'),'first');const first=locations(directory);fs.writeFileSync(path.join(directory,'requirements.txt'),'second');const second=locations(directory);assert.notEqual(first.runtime,second.runtime);assert.equal(first.home,second.home);}finally{assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true});}
});
test('tar extraction writes no archive paths and selects only uv binary',()=>{
 const header=Buffer.alloc(512);header.write('../../untrusted/uv');header.write('00000000003\0',124);header[156]=48;const tar=Buffer.concat([header,Buffer.from('abc'),Buffer.alloc(509),Buffer.alloc(512)]);
 assert.equal(binaryFromTar(zlib.gzipSync(tar)).toString(),'abc'); // Caller writes bytes only to its fixed private destination.
 assert.throws(()=>binaryFromTar(zlib.gzipSync(Buffer.alloc(512))));
});
test('ready marker requires both interpreter and exact dependency fingerprint',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'commitops-marker-'));const python=path.join(directory,'python'),marker=path.join(directory,'ready');
 try{const info={python,marker,fingerprint:'expected'};assert.equal(ready(info),false);fs.writeFileSync(python,'fixture');fs.writeFileSync(marker,'old');assert.equal(ready(info),false);fs.writeFileSync(marker,'expected');assert.equal(ready(info),true);}finally{fs.rmSync(directory,{recursive:true,force:true});}
});
