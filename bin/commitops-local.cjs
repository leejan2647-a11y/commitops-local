#!/usr/bin/env node
'use strict';
const {spawn}=require('node:child_process');
const path=require('node:path');
const {setup}=require('./runtime.cjs');
const root=path.resolve(__dirname,'..');const args=process.argv.slice(2);
if(args.includes('--help')){console.log('commitops [--port 43187] [--setup]\nFirst installation provisions a private Python runtime. Analysis stays offline.');process.exit(0);}
async function main(){
 const info=await setup(root);
 if(args.includes('--setup')){console.log('Setup complete. Run commitops.');return;}
 const env={};
 for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','HOME','USERPROFILE','LOCALAPPDATA','LANG'])if(process.env[key])env[key]=process.env[key];
 env.PYTHONNOUSERSITE='1';env.PYTHONDONTWRITEBYTECODE='1';
 const child=spawn(info.python,[path.join(root,'engine','local_app.py'),'--data',path.join(info.home,'data'),...args],{stdio:'inherit',shell:false,env});
 child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code||0;});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
