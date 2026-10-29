'use strict';
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), crypto=require('node:crypto'), zlib=require('node:zlib');
const {spawnSync}=require('node:child_process');
const VERSION='0.13.5';
const ASSETS={
 'win32-x64':['uv-x86_64-pc-windows-msvc.zip','a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a'],
 'win32-arm64':['uv-aarch64-pc-windows-msvc.zip','09f47edf90726084a70f9426f6e3ca4f46e9bf7cbf23b1716ec64d60b055fae3'],
 'linux-x64':['uv-x86_64-unknown-linux-gnu.tar.gz','f68d291c75783122dad58ab77def0e13f3233f358731db5d6d7e8715603b928f'],
 'linux-arm64':['uv-aarch64-unknown-linux-gnu.tar.gz','4bb69cf95ed13f23713bb7bc09f241896ea0c75b7c557e615a20604b82f9c403'],
 'darwin-x64':['uv-x86_64-apple-darwin.tar.gz','b0f52b0e3945b4107d89024ea38e625683011fbfc05a0d98f9fa2d6dcee28c66'],
 'darwin-arm64':['uv-aarch64-apple-darwin.tar.gz','743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73']
};
function locations(root){
 const home=path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'.local','share'),'commitops-local');
 const fingerprint=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'requirements.txt'))).update('managed-python-3.12-v2').digest('hex');
 const runtime=path.join(home,'runtime-v2-'+fingerprint.slice(0,16));
 return {home,runtime,python:path.join(runtime,process.platform==='win32'?'Scripts/python.exe':'bin/python'),marker:path.join(runtime,'.ready'),fingerprint};
}
function ready(info){return fs.existsSync(info.python)&&fs.existsSync(info.marker)&&fs.readFileSync(info.marker,'utf8')===info.fingerprint;}
function binaryFromTar(archive){
 const tar=zlib.gunzipSync(archive,{maxOutputLength:200*1024*1024});
 for(let offset=0;offset+512<=tar.length;){
  const header=tar.subarray(offset,offset+512),name=header.subarray(0,100).toString().split('\0')[0];
  if(!name)break;
  const size=parseInt(header.subarray(124,136).toString().replace(/\0/g,'').trim(),8);
  if(!Number.isSafeInteger(size)||size<0||offset+512+size>tar.length)throw Error('Invalid runtime archive');
  if(path.posix.basename(name)==='uv'&&[0,48].includes(header[156]))return tar.subarray(offset+512,offset+512+size);
  offset+=512+Math.ceil(size/512)*512;
 }
 throw Error('Runtime binary missing from archive');
}
async function uvBinary(info){
 const spec=ASSETS[process.platform+'-'+process.arch];
 if(!spec)throw Error('Automatic installation supports Windows/macOS/Linux x64 and ARM64. This platform is unsupported.');
 const folder=path.join(info.home,'tools',VERSION),binary=path.join(folder,process.platform==='win32'?'uv.exe':'uv'),stamp=binary+'.sha256';
 if(fs.existsSync(binary)&&fs.existsSync(stamp)&&crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex')===fs.readFileSync(stamp,'utf8'))return binary;
 console.log('Downloading verified local runtime installer…');
 const response=await fetch(`https://github.com/astral-sh/uv/releases/download/${VERSION}/${spec[0]}`,{signal:AbortSignal.timeout(120000)});
 if(!response.ok)throw Error('Runtime download failed: HTTP '+response.status);
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>50*1024*1024)throw Error('Runtime archive exceeds expected size');chunks.push(chunk);}
 const archive=Buffer.concat(chunks);
 if(crypto.createHash('sha256').update(archive).digest('hex')!==spec[1])throw Error('Runtime download checksum mismatch');
 let contents;
 if(spec[0].endsWith('.zip')){
  const {unzipSync}=require('fflate');const files=unzipSync(archive,{filter:entry=>entry.name.split('/').pop()==='uv.exe'&&entry.originalSize<100*1024*1024});
  contents=Object.entries(files).find(([name])=>name.split('/').pop()==='uv.exe')?.[1];
 }else contents=binaryFromTar(archive);
 if(!contents?.length)throw Error('Runtime binary missing');
 fs.mkdirSync(folder,{recursive:true,mode:0o700});const temporary=binary+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,contents,{mode:0o700});fs.renameSync(temporary,binary);
 fs.writeFileSync(stamp,crypto.createHash('sha256').update(contents).digest('hex'),{mode:0o600});return binary;
}
async function setup(root){
 const info=locations(root);if(ready(info))return info;
 fs.mkdirSync(info.home,{recursive:true,mode:0o700});const lock=path.join(info.home,'.setup-lock');
 // Exclusive lock file: another install must finish rather than sharing a partial runtime.
 let handle;
 try{handle=fs.openSync(lock,'wx',0o600);fs.writeSync(handle,String(process.pid));}
 catch(error){
  if(error.code!=='EEXIST')throw error;
  const pid=Number(fs.readFileSync(lock,'utf8'));let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
  if(!alive){fs.unlinkSync(lock);return setup(root);}
  for(let i=0;i<240;i++){await new Promise(resolve=>setTimeout(resolve,1000));if(ready(info))return info;if(!fs.existsSync(lock))return setup(root);}
  throw Error('Another runtime setup is still running. Retry after it finishes.');
 }
 try{
  if(ready(info))return info;
  const uv=await uvBinary(info);
  const env={...process.env,UV_PYTHON_INSTALL_DIR:path.join(info.home,'python'),UV_NO_CONFIG:'1',UV_PYTHON_DOWNLOADS:'automatic'};
  console.log('Installing private Python 3.12 and analysis dependencies. Billing files are not accessed.');
  for(const args of [['venv','--python','3.12','--managed-python','--allow-existing',info.runtime],['pip','install','--python',info.python,'--only-binary',':all:','--index-url','https://pypi.org/simple','-r',path.join(root,'requirements.txt')]]){
   const result=spawnSync(uv,args,{env,stdio:'inherit',shell:false,timeout:600000});
   if(result.error||result.status!==0)throw Error('Runtime setup failed. Check internet access and disk space, then restart commitops to retry.');
  }
  const probe=spawnSync(info.python,['-c','import duckdb,pydantic,pyarrow,pytz,dateutil,psutil'],{env,stdio:'inherit',timeout:30000});
  if(probe.error||probe.status!==0)throw Error('Installed analysis dependencies did not pass verification');
  fs.writeFileSync(info.marker,info.fingerprint,{mode:0o600});return info;
 }finally{fs.closeSync(handle);fs.unlinkSync(lock);}
}
module.exports={locations,ready,binaryFromTar,setup,ASSETS};
if(require.main===module)setup(path.resolve(__dirname,'..')).then(()=>console.log('Local runtime ready.')).catch(error=>{console.error(error.message);process.exitCode=1;});
