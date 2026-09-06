#!/usr/bin/env node
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createProject,loadProject,inspectFile,expandInputs,importFiles,configure,optimize,replay,makePolicy} from './project.mjs';
import {exportDelivery,verifyDelivery} from './delivery.mjs';
import {saveJson} from './util.mjs';
import {serve} from './server.mjs';
const args=process.argv.slice(2),command=args.shift();
function option(name,fallback){const index=args.indexOf('--'+name);if(index<0)return fallback;const value=args[index+1];if(value===undefined||value.startsWith('--'))throw new Error(`Missing --${name} value`);args.splice(index,2);return value;}
const help=`AssetFit — Visual Asset Budget Optimizer

Usage (Node.js 22.13+):
  pnpm start                              Open local workspace at 127.0.0.1:4318
  pnpm cli inspect <files...>              Inspect supported image/GLB capabilities
  pnpm cli optimize <files/folders...> --budget <bytes> [--out <project-dir>]
      [--name <name>] [--evaluations <1..64>] [--seed <integer>] [--policy <policy.json>]
  pnpm cli resume <project-dir>            Resume preserved observations and candidates
  pnpm cli configure <project-dir> <patch.json>
  pnpm cli solve <project-dir>             Reallocate existing measured candidate table
  pnpm cli export <project-dir> [--tier standard]
  pnpm cli replay <recipe.json> <files...> [--out <projects-root>]
  pnpm cli verify <delivery-dir>           Verify actual asset bytes, hashes and GLB validity
  pnpm cli policy <project-dir> <policy.json>
  pnpm cli serve [--port 4318] [--root <projects-root>]

Budget = selected visual files only. 1 MB = 1,000,000 bytes; 1 MiB = 1,048,576 bytes.
Original inputs are copied into managed projects and never overwritten.
Default limits: 40 assets, 100 MB/file, 500 MB source/project; serial encoding.
Ctrl-C cancels between processing steps and preserves measured progress.
Exit codes: 0 completed command, 1 command error, 2 failed/partial processing or verification mismatch, 130 cancelled processing.
An exhausted candidate table with no feasible allocation is reported in JSON; it is not a global impossibility claim.
`;
let service;const controller=new AbortController();process.on('SIGINT',async()=>{if(service){console.error('Stopping local service after current safe processing steps…');await service.close();process.exit(0);}controller.abort();console.error('Cancelling after current processing step…');});
const runOptions={signal:controller.signal,onProgress:e=>console.error(e.message)};
try{let result;
 switch(command){
 case 'serve':service=await serve({port:Number(option('port','4318')),root:option('root')});break;
 case 'inspect':result=await Promise.all(args.map(async file=>{try{return {name:path.basename(file),...await inspectFile(file)};}catch(e){return {name:path.basename(file),supported:false,error:e.message};}}));break;
 case 'optimize':{const budget=Number(option('budget','1000000')),out=option('out',path.resolve('.assetfit/projects')),name=option('name','Asset project'),maxEvaluations=Number(option('evaluations','12')),seed=Number(option('seed','42')),policyFile=option('policy');const policy=policyFile?JSON.parse(await readFile(policyFile,'utf8')):null;if(policy&&policy.kind!=='policy')throw new Error('Expected a policy, not an asset-bound recipe');
 const {dir,project:p}=await createProject(out,{name,budgets:policy?.budgets??[{name:'standard',bytes:budget}],settings:policy?.settings??{maxEvaluations,seed}});await importFiles(dir,p,await expandInputs(args));if(policy?.defaults)for(const a of p.assets){a.usages=[policy.defaults[a.type]];a.constraints={...a.constraints,...policy.defaults.constraints};}await optimize(dir,p,runOptions);result={projectDir:dir,status:p.status,allocations:p.allocations,importFailures:p.importFailures,cost:p.cost};break;}
 case 'resume':{const dir=path.resolve(args[0]),p=await loadProject(dir);await optimize(dir,p,runOptions);result={status:p.status,allocations:p.allocations};break;}
 case 'configure':{const dir=path.resolve(args[0]),p=await loadProject(dir);result=await configure(dir,p,JSON.parse(await readFile(args[1],'utf8')));break;}
 case 'solve':{const {solve}=await import('./project.mjs');const dir=path.resolve(args[0]),p=await loadProject(dir);result=await solve(dir,p);break;}
 case 'export':{const tier=option('tier','standard'),dir=path.resolve(args[0]);result=await exportDelivery(dir,await loadProject(dir),tier);break;}
 case 'verify':result=await verifyDelivery(path.resolve(args[0]));if(!result.valid)process.exitCode=2;break;
 case 'replay':{const out=option('out',path.resolve('.assetfit/projects')),recipe=JSON.parse(await readFile(args.shift(),'utf8'));const r=await replay(out,recipe,await expandInputs(args),runOptions);result={projectDir:r.dir,status:r.project.status,replay:r.project.replay};if(!r.project.replay?.consistent)process.exitCode=2;break;}
 case 'policy':await saveJson(args[1],makePolicy(await loadProject(path.resolve(args[0]))));result={saved:args[1]};break;
 default:console.log(help);if(command&&command!=='help'&&command!=='--help')process.exitCode=1;
 }
 if(result){if(result.status==='cancelled')process.exitCode=130;else if(['failed','partial'].includes(result.status))process.exitCode=2;console.log(JSON.stringify(result,null,2));}
}catch(e){console.error(e.message);process.exitCode=e.name==='AbortError'?130:1;}
