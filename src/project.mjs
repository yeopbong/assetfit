import path from 'node:path';
import {readFile,copyFile,mkdir,readdir,realpath,stat,statfs} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {inspectImage,generateImageCandidates,IMAGE_VERSION} from './images.mjs';
import {inspectGlb,generateGlbCandidates,GLB_PIPELINE_VERSION,resolveGlbProtection} from './glb.mjs';
import {createRenderer,RENDERER_VERSION} from './renderer.mjs';
import {METRIC_VERSION} from './metrics.mjs';
import sharp from 'sharp';
import {allocate} from './allocator.mjs';
import {VERSION,hash,fileHash,uid,safeName,saveJson,inside,abort,checkBudget} from './util.mjs';
export const limits={files:40,fileBytes:100_000_000,totalBytes:500_000_000};

function normalizeBudgets(budgets){
 if(!Array.isArray(budgets)||budgets.length<1||budgets.length>8)throw new Error('Use 1–8 named budgets');
 const names=new Set();return budgets.map(b=>{checkBudget(b.bytes);if(typeof b.name!=='string'||!b.name.trim())throw new Error('Budget name is required');const name=safeName(b.name);if(['__proto__','constructor','prototype'].includes(name)||names.has(name))throw new Error('Budget names must be unique and non-reserved');names.add(name);return {name,bytes:b.bytes};});
}
function validateSettings(settings){if(!Number.isSafeInteger(settings.maxEvaluations)||settings.maxEvaluations<1||settings.maxEvaluations>64)throw new Error('Use 1–64 GLB measurements');if(!Number.isSafeInteger(settings.seed))throw new Error('Seed must be an integer');if(!['evolutionary','random','uniform','greedy'].includes(settings.method))throw new Error('Unknown search method');return settings;}


async function diskGuard(dir,asset){
 let used=0;const pending=[dir];while(pending.length){const current=pending.pop();for(const entry of await readdir(current,{withFileTypes:true})){const file=path.join(current,entry.name);if(entry.isDirectory())pending.push(file);else if(entry.isFile())used+=(await stat(file)).size;}}
 const viewPixels=asset.usages.reduce((sum,u)=>sum+u.width*u.height*u.dpr*u.dpr*(asset.type==='glb'?(u.cameras?.length||3)+2:1),0);
 const reserve=Math.max(64*1024*1024,asset.sourceBytes*3+viewPixels*16);const info=await statfs(dir);if(info.bavail*info.bsize<reserve+256*1024*1024)throw new Error('Insufficient free disk space for a safe candidate measurement; existing files are preserved.');
 if(used+reserve>2*1024*1024*1024)throw new Error('Managed project storage limit reached (2 GiB including a conservative next-candidate reserve). Existing inputs, measurements and exports are preserved.');
}

export const defaultUsage=type=>({width:type==='glb'?256:512,height:type==='glb'?256:512,dpr:1,fit:'contain',weight:1,regions:[]});
export async function createProject(root,{name='Untitled project',budgets=[{name:'standard',bytes:1_000_000}],settings={}}={}){
 budgets=normalizeBudgets(budgets);settings=validateSettings({maxEvaluations:12,seed:42,method:'evolutionary',...settings});
 const id=uid(),dir=path.resolve(root,id);await mkdir(path.join(dir,'inputs'),{recursive:true});
 const p={schemaVersion:1,version:VERSION,environment:{node:process.versions.node,platform:process.platform,arch:process.arch,sharp:sharp.versions,renderer:RENDERER_VERSION,metric:METRIC_VERSION},id,name:String(name).slice(0,120),assets:[],budgets,settings:{maxEvaluations:12,seed:42,method:'evolutionary',...settings},status:'ready',observations:[],allocations:{},cost:{elapsedMs:0,imageMs:0,glbMs:0,allocationMs:0,cacheHits:0,retries:0},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 await persist(dir,p);return {dir,project:p};
}
export async function loadProject(dir){const p=JSON.parse(await readFile(path.join(dir,'project.json'),'utf8'));if(p.schemaVersion!==1)throw new Error('Unsupported project version');return p;}
export async function persist(dir,p){p.updatedAt=new Date().toISOString();await saveJson(path.join(dir,'project.json'),p);}
export async function inspectFile(file){const ext=path.extname(file).toLowerCase();return ext==='.glb'?await inspectGlb(file):await inspectImage(file);}
export async function expandInputs(inputs){const result=[];for(const input of inputs){const s=await stat(input);if(s.isDirectory()){for(const entry of await readdir(input,{withFileTypes:true})){if(entry.name.startsWith('.'))continue;const f=path.join(input,entry.name);if(entry.isDirectory())result.push(...await expandInputs([f]));else if(entry.isFile())result.push(f);}}else result.push(input);}if(result.length>limits.files)throw new Error(`At most ${limits.files} input paths per import.`);return result;}
export async function importFiles(dir,p,files,{names}={}){
 const failures=[];for(let i=0;i<files.length;i++){const file=files[i];try{
  if(p.assets.length>=limits.files)throw new Error(`Project limit: ${limits.files} assets`);
  const resolved=await realpath(file),sourceKey=hash(resolved),prior=p.assets.find(a=>a.sourceKey===sourceKey);
  if(prior){prior.usages.push(defaultUsage(prior.type));continue;}
  const s=await stat(resolved);if(!s.isFile()||s.size>limits.fileBytes)throw new Error('Input must be a file of at most 100 MB');
  if(p.assets.reduce((sum,a)=>sum+a.sourceBytes,0)+s.size>limits.totalBytes)throw new Error('Project source limit: 500 MB');
  const cap=await inspectFile(resolved);if(cap.supported===false)throw new Error(`Unsupported input: ${JSON.stringify(cap.diagnostics)}`);
  const type=path.extname(file).toLowerCase()==='.glb'?'glb':'image';const sourceHash=await fileHash(resolved),id=uid();
  const name=String(names?.[i]??path.basename(file)).slice(0,180),source=`inputs/${id}${path.extname(file).toLowerCase()}`;await copyFile(resolved,inside(dir,source));
  let license,licenseText;try{const exampleDir=fileURLToPath(new URL('../examples/',import.meta.url));const provenance=JSON.parse(await readFile(path.join(exampleDir,'SOURCES.json'),'utf8'));license=provenance.assets.find(v=>v.sha256===sourceHash);if(license?.licenseFile)licenseText=await readFile(inside(exampleDir,license.licenseFile),'utf8');}catch{}
  p.assets.push({id,name,type,license,licenseText,source,sourceKey,sourceHash,sourceBytes:s.size,capabilities:cap,usages:[defaultUsage(type)],priority:1,constraints:{preserveAlpha:true,formats:['jpeg','png','webp']},candidates:[],status:'ready'});
 }catch(e){failures.push({name:names?.[i]??path.basename(file),message:e.message});}}
 p.importFailures=failures;p.allocations={};await persist(dir,p);return {imported:p.assets.length,failures};
}
function validUsage(u,type){
 for(const key of ['width','height','dpr','weight'])if(!Number.isFinite(u[key])||u[key]<=0)throw new Error(`Usage ${key} must be positive`);
 if(!Number.isInteger(u.width)||!Number.isInteger(u.height)||u.width*u.height*u.dpr*u.dpr>4_000_000)throw new Error('Usage raster must fit 4 million pixels');
 if(type==='glb'&&u.width*u.height*u.dpr*u.dpr>1_000_000)throw new Error('3D evaluation is limited to 1 million pixels per view');
 if(!['contain','cover','fill'].includes(u.fit))throw new Error('Invalid image fit');
}
export async function configure(dir,p,patch){
 const target=p;p=structuredClone(p);
 if(p.status==='running'||p.exporting)throw new Error('Wait for export or cancel processing before changing evaluation conditions');
 if(patch.name!==undefined)p.name=String(patch.name).slice(0,120);
 if(patch.budgets)p.budgets=normalizeBudgets(patch.budgets);
 if(patch.settings){const s={...p.settings,...patch.settings};if(!Number.isSafeInteger(s.maxEvaluations)||s.maxEvaluations<1||s.maxEvaluations>64)throw new Error('Use 1–64 GLB measurements');if(!Number.isSafeInteger(s.seed))throw new Error('Seed must be an integer');if(!['evolutionary','random','uniform','greedy'].includes(s.method))throw new Error('Unknown search method');p.settings=s;}
 if(patch.assets){for(const update of patch.assets){const a=p.assets.find(a=>a.id===update.id);if(!a)throw new Error('Asset not found');if(update.priority!==undefined){if(!Number.isFinite(update.priority)||update.priority<=0||update.priority>100)throw new Error('Priority must be in (0,100]');a.priority=update.priority;}
   if(update.usages){if(!update.usages.length||update.usages.length>8)throw new Error('Use 1–8 usages per asset');update.usages.forEach(u=>validUsage(u,a.type));a.usages=update.usages;}
   if(update.constraints)a.constraints={...a.constraints,...update.constraints};if(a.type==='glb')a.protection=resolveGlbProtection(a.capabilities,a.constraints,a.usages);
 }}
 for(const a of p.assets){if(a.epoch&&a.epoch!==epoch(a,p)){a.status='stale';}}
 p.allocations={};p.status='ready';await persist(dir,p);Object.assign(target,p);return target;
}
export function epoch(a,p){return hash(JSON.stringify({version:VERSION,generators:{image:IMAGE_VERSION,glb:GLB_PIPELINE_VERSION,renderer:RENDERER_VERSION,metric:METRIC_VERSION},source:a.sourceHash,usages:a.usages,constraints:a.constraints,settings:p.settings}));}
function relocate(value,dir,toRelative){if(Array.isArray(value))return value.map(v=>relocate(v,dir,toRelative));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,relocate(v,dir,toRelative)]));if(typeof value==='string'&&toRelative&&value.startsWith(dir+path.sep))return path.relative(dir,value);return value;}
export async function optimize(dir,p,{signal,onProgress=()=>{}}={}){
 dir=path.resolve(dir);
 if(!p.assets.length)throw new Error('Import at least one supported asset');
 if(['cancelled','interrupted','partial','failed'].includes(p.status))p.cost.retries++;
 p.status='running';p.error=null;const started=performance.now();let renderer;
 await persist(dir,p);
 try{for(const a of p.assets){abort(signal);if(await fileHash(inside(dir,a.source))!==a.sourceHash)throw new Error(`Managed source hash mismatch: ${a.name}`);const key=epoch(a,p);const outputDir=path.join(dir,'candidates',a.id,key.slice(0,16));await mkdir(outputDir,{recursive:true});
   if(a.epoch===key&&a.status==='complete'&&a.candidates.length){let valid=true;for(const c of a.candidates.filter(c=>c.valid))try{if(await fileHash(inside(dir,c.file))!==c.hash)valid=false;}catch{valid=false;}if(valid){p.cost.cacheHits++;onProgress({asset:a.id,message:'Reusing verified candidate archive'});continue;}}
   if(a.epoch!==key){a.candidates=[];a.observations=[];a.reference=null;}a.epoch=key;a.status='running';
   await diskGuard(dir,a);const assetStart=performance.now();let evaluate;
   const saveCandidate=async c=>{const stored=relocate(c,dir,true);a.candidates=a.candidates.filter(v=>v.id!==c.id);a.candidates.push(stored);await persist(dir,p);onProgress({asset:a.id,candidate:c.id,message:`Measured ${a.name}: ${c.bytes.toLocaleString()} bytes`});};
   const onObservation=async observation=>{if(observation.event==='proposal'||observation.phase==='proposal')await diskGuard(dir,a);const row=relocate({...observation,assetId:a.id,epoch:key},dir,true);a.observations??=[];a.observations.push(row);p.observations.push(row);await persist(dir,p);};
   try{if(a.type==='glb'){
    renderer??=await createRenderer({workDir:path.join(dir,'renders')});a.reference=await renderer.reference(inside(dir,a.source),a.usages);
    evaluate=async file=>renderer.evaluate(file,a.reference);
   }
   const resumeCandidates=a.candidates.map(c=>({...c,file:inside(dir,c.file)}));
   const restoreObservation=row=>({...row,candidate:row.candidate?{...row.candidate,file:inside(dir,row.candidate.file)}:undefined});
   const resumeObservations=(a.observations??[]).map(restoreObservation);
   const args={sourcePath:inside(dir,a.source),outputDir,asset:a,settings:{...p.settings,evaluationKey:a.reference?.settingsHash,resumeCandidates,resumeObservations},observations:resumeObservations,evaluate,onCandidate:saveCandidate,onObservation,signal};
   const result=a.type==='glb'?await generateGlbCandidates(args):await generateImageCandidates(args);
   a.candidates=relocate(Array.isArray(result)?result:result.candidates,dir,true);a.reference=relocate(a.reference,dir,true);
   const processingErrors=a.type==='image'?(result.observations??[]).filter(o=>o.phase==='failed').flatMap(o=>o.diagnostics??[]):a.candidates.filter(c=>!c.valid&&c.diagnostics?.error).map(c=>c.diagnostics.error);
   if(!a.candidates.some(c=>c.valid)&&processingErrors.length){a.status='failed';a.error=`No valid measured candidate was produced. ${processingErrors[0]}`;}else{a.status='complete';a.error=null;}
   }catch(e){a.reference=relocate(a.reference,dir,true);a.status=e.name==='AbortError'?'interrupted':'failed';a.error=e.message;await persist(dir,p);if(e.name==='AbortError')throw e;}
   finally{p.cost[a.type==='glb'?'glbMs':'imageMs']+=performance.now()-assetStart;await persist(dir,p);}
 }
 abort(signal);await solve(dir,p);
 if(renderer){for(const a of p.assets.filter(v=>v.type==='glb'&&v.status==='complete')){const selectedIds=new Set(Object.values(p.allocations).filter(v=>v.feasible).map(v=>v.selected[a.id]));if(!selectedIds.size)continue;const reference=await renderer.reference(inside(dir,a.source),a.usages);for(const id of selectedIds){abort(signal);const c=a.candidates.find(c=>c.id===id);const checkStart=performance.now();c.finalCheck=relocate(await renderer.evaluate(inside(dir,c.file),reference,{heldout:true}),dir,true);p.cost.heldoutMs=(p.cost.heldoutMs??0)+performance.now()-checkStart;}await persist(dir,p);}}
 const failedAssets=p.assets.filter(a=>a.status==='failed');p.status=failedAssets.length===p.assets.length?'failed':failedAssets.length?'partial':'complete';if(p.status==='failed')p.error='All assets failed candidate processing. Inspect asset errors; original inputs and constraints are preserved.';
 }catch(e){p.status=e.name==='AbortError'?'cancelled':'failed';p.error=e.message;if(e.name!=='AbortError')throw e;}
 finally{await renderer?.close();p.cost.elapsedMs+=performance.now()-started;await persist(dir,p);}
 return p;
}
export async function solve(dir,p){
 if(p.assets.some(a=>a.epoch!==epoch(a,p)))throw new Error('Usage or constraints changed. Generate or resume candidates before allocation.');
 const start=performance.now();p.allocations={};for(const budget of p.budgets)p.allocations[budget.name]=allocate(p.assets,budget.bytes);p.cost.allocationMs+=performance.now()-start;await persist(dir,p);return p.allocations;
}
export function makeRecipe(p){return {schemaVersion:1,kind:'recipe',version:VERSION,environment:p.environment,name:p.name,settings:p.settings,budgets:p.budgets,manualChoices:Object.fromEntries(Object.entries(p.allocations).filter(([,v])=>v.method==='user-selected-alternative').map(([name,v])=>[name,Object.fromEntries(p.assets.map(a=>[a.id,a.candidates.find(c=>c.id===v.selected[a.id]).hash]))])),assets:p.assets.map(a=>({id:a.id,name:a.name,sourceHash:a.sourceHash,sourceBytes:a.sourceBytes,usages:a.usages,constraints:a.constraints,priority:a.priority,selectedHashes:Object.fromEntries(Object.entries(p.allocations).filter(([,v])=>v.feasible).map(([name,v])=>[name,a.candidates.find(c=>c.id===v.selected[a.id])?.hash]))}))};}
export function makePolicy(p){return {schemaVersion:1,kind:'policy',version:VERSION,budgets:p.budgets,settings:p.settings,defaults:{image:defaultUsage('image'),glb:defaultUsage('glb'),constraints:{preserveAlpha:true,formats:['jpeg','png','webp']}}};}
export async function replay(root,recipe,inputs,options={}){
 if(!Array.isArray(recipe.assets)||recipe.assets.some(a=>!(/^[a-zA-Z0-9-]+$/).test(a.id)||['constructor','prototype','__proto__'].includes(a.id))||new Set(recipe.assets.map(a=>a.id)).size!==recipe.assets.length)throw new Error('Invalid recipe asset ID or duplicate mapping');
 if(recipe.environment&&(recipe.environment.renderer!==RENDERER_VERSION||recipe.environment.metric!==METRIC_VERSION||recipe.environment.sharp?.vips!==sharp.versions.vips))throw new Error('Recipe toolchain version mismatch');
 if(recipe.kind!=='recipe'||recipe.version!==VERSION)throw new Error('Recipe version mismatch; replay requires the recorded version');
 const created=await createProject(root,{name:`${recipe.name} replay`,budgets:recipe.budgets,settings:recipe.settings});const {dir,project:p}=created;
 await importFiles(dir,p,inputs);if(p.importFailures.length)throw new Error('Some replay inputs were rejected');
 const available=[...p.assets];p.assets=[];for(const expected of recipe.assets){const index=available.findIndex(a=>a.sourceHash===expected.sourceHash&&a.name===expected.name);if(index<0)throw new Error(`Replay source mismatch: ${expected.name}`);const a=available.splice(index,1)[0];Object.assign(a,{id:expected.id,usages:expected.usages,constraints:expected.constraints,priority:expected.priority});p.assets.push(a);}
 if(available.length)throw new Error('Unexpected extra replay inputs');await persist(dir,p);await optimize(dir,p,options);
 for(const [name,choices] of Object.entries(recipe.manualChoices??{})){const budget=p.budgets.find(b=>b.name===name);if(!budget)throw new Error('Manual recipe budget missing');const allocation=allocate(p.assets.map(a=>({...a,candidates:a.candidates.filter(c=>c.hash===choices[a.id])})),budget.bytes);if(!allocation.feasible)throw new Error('Manual recipe selection could not be reproduced');p.allocations[name]={...allocation,exact:false,method:'user-selected-alternative',scope:'Replayed explicit user selection.'};}
 p.replay={consistent:true,checks:[]};for(const a of p.assets){const expected=recipe.assets.find(v=>v.id===a.id);for(const [budget,expectedHash] of Object.entries(expected.selectedHashes??{})){const choice=p.allocations[budget]?.selected?.[a.id],actual=a.candidates.find(c=>c.id===choice)?.hash;const match=actual===expectedHash;p.replay.checks.push({assetId:a.id,budget,expectedHash,actualHash:actual,match});if(!match)p.replay.consistent=false;}}
 await persist(dir,p);return created;
}

export async function replaceCandidate(dir,p,budgetName,assetId,candidateId){
 if(p.status==='running'||p.exporting)throw new Error('Wait for candidate processing or delivery export');
 if(p.assets.some(a=>a.epoch!==epoch(a,p)))throw new Error('Remeasure stale candidates before changing selection');
 const old=p.allocations[budgetName];if(!old?.feasible)throw new Error('A feasible allocation is required');
 const asset=p.assets.find(a=>a.id===assetId),candidate=asset?.candidates.find(c=>c.id===candidateId&&c.valid);if(!candidate)throw new Error('Valid candidate not found');
 const selected={...old.selected,[assetId]:candidateId};let bytes=0,loss=0,totalWeight=0;const contributions=[];for(const a of p.assets){const c=a.candidates.find(c=>c.id===selected[a.id]);bytes+=c.bytes;loss+=a.priority*c.metrics.loss;totalWeight+=a.priority;contributions.push({assetId:a.id,candidateId:c.id,bytes:c.bytes,priority:a.priority,loss:c.metrics.loss,weightedLoss:a.priority*c.metrics.loss});}
 const budget=p.budgets.find(b=>b.name===budgetName).bytes;if(!Number.isSafeInteger(bytes)||bytes>budget)throw new Error(`This alternative needs ${bytes-budget} additional asset bytes`);
 p.allocations[budgetName]={...old,selected,bytes,loss,normalizedLoss:loss/totalWeight,slack:budget-bytes,exact:false,method:'user-selected-alternative',scope:'User-replaced candidate in a feasible measured allocation; no optimality claim.',contributions};await persist(dir,p);return p;
}
