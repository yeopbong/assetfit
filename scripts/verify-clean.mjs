import {mkdtemp,cp,mkdir,readFile,writeFile,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const clean=await realpath(await mkdtemp(path.join(tmpdir(),'assetfit clean ')));
const entries=['src','web','scripts','tests','examples','docs','.github','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','start.command','.gitignore','README.md','LICENSE','THIRD_PARTY_NOTICES.md'];
for(const entry of entries){
 try{await stat(path.join(root,entry));}catch{continue;}
 await cp(path.join(root,entry),path.join(clean,entry),{recursive:true,filter:source=>!source.includes(path.join('examples','demo'))});
}
const env={...process.env,XDG_CACHE_HOME:path.join(clean,'.install-cache')};
const timings=[],logs=[];
async function run(command,args){
 const started=performance.now();
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd:clean,env,stdio:['ignore','pipe','pipe']});let out='',err='';
  child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);
  child.once('error',reject);child.once('exit',code=>resolve({code,out,err}));
 });
 logs.push({command:path.basename(command),args,...result});
 timings.push({command:[path.basename(command),...args].join(' '),elapsedMs:performance.now()-started,exitCode:result.code});
 if(result.code!==0)throw new Error(`${command} failed (${result.code}): ${result.err}\n${result.out}`);
 return result.out;
}
let service;
try{
 assert(!(await stat(path.join(clean,'node_modules')).catch(()=>null)));
 const packageManager=(await run('pnpm',['--version'])).trim();assert.equal(packageManager,'11.19.0');
 await run('pnpm',['install','--frozen-lockfile','--store-dir','.install-store']);
 await run('pnpm',['build']);
 await run('pnpm',['typecheck']);
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const started=performance.now();let serverLog='';
 service=spawn(process.platform==='win32'?process.execPath:'./start.command',process.platform==='win32'?['src/cli.mjs','serve','--port',String(port)]:['--port',String(port)],{cwd:clean,env,stdio:['ignore','pipe','pipe']});
 service.stdout.on('data',data=>serverLog+=data);service.stderr.on('data',data=>serverLog+=data);
 let healthy=false;
 for(let i=0;i<100;i++){
  if(service.exitCode!==null)throw new Error(`Clean launcher stopped: ${serverLog}`);
  try{healthy=(await(await fetch(`http://127.0.0.1:${port}/api/health`)).json()).mode==='local';if(healthy)break;}catch{}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert(healthy,'Clean launcher must expose a working API');
 assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status,200);
 assert.equal((await fetch(`http://127.0.0.1:${port}/demo/project.json`)).status,200);
 timings.push({command:'start.command and HTTP startup',elapsedMs:performance.now()-started,exitCode:0});
 const processed=JSON.parse(await run(process.execPath,['src/cli.mjs','optimize','examples/sources/Duck.glb','examples/sources/astronaut.png','--name','Clean install mixed smoke','--budget','180000','--evaluations','5','--out','.assetfit/projects']));
 assert.equal(processed.status,'complete');assert(processed.allocations.standard.feasible);
 const projectDir=path.relative(clean,path.resolve(clean,processed.projectDir));
 const project=JSON.parse(await readFile(path.join(clean,projectDir,'project.json'),'utf8'));
 assert.deepEqual(project.assets.map(a=>a.type),['glb','image']);
 const delivery=JSON.parse(await run(process.execPath,['src/cli.mjs','export',projectDir]));
 const verified=JSON.parse(await run(process.execPath,['src/cli.mjs','verify',path.join(projectDir,path.dirname(delivery.archive))]));
 assert(verified.valid);
 const proof={schemaVersion:1,platform:process.platform,arch:process.arch,node:process.versions.node,pnpm:packageManager,
  cleanPathContainsSpaces:clean.includes(' '),freshDependencyStore:true,existingNodeModulesCopied:false,generatedCachesCopied:false,
  declaredSystemBrowser:true,launcherAndHttpVerified:true,typecheck:true,build:true,
  mixedProject:{status:processed.status,assetTypes:project.assets.map(a=>a.type),candidates:project.assets.map(a=>({name:a.name,valid:a.candidates.filter(c=>c.valid).length})),assetBytes:verified.assetBytes,budgetBytes:180000,verification:verified},timings};
 await mkdir(path.join(root,'artifacts'),{recursive:true});
 await writeFile(path.join(root,'artifacts/clean-install-verification.json'),JSON.stringify(proof,null,2));
 await writeFile(path.join(root,'artifacts/clean-install-log.json'),JSON.stringify({temporaryDirectory:clean,logs},null,2));
 console.log(JSON.stringify(proof,null,2));
 console.log('Clean installation retained for review; its path is in artifacts/clean-install-log.json.');
}catch(error){
 await mkdir(path.join(root,'artifacts'),{recursive:true});
 await writeFile(path.join(root,'artifacts/clean-install-log.json'),JSON.stringify({temporaryDirectory:clean,logs,timings,error:error.message},null,2));
 throw error;
}finally{if(service&&service.exitCode===null){service.kill('SIGINT');await new Promise(resolve=>service.once('exit',resolve));}}
