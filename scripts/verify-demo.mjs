import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import {chromium} from 'playwright';
import JSZip from 'jszip';
import {fileHash,inside} from '../src/util.mjs';
import {allocate} from '../src/allocator.mjs';
import {verifyDelivery} from '../src/delivery.mjs';
import {chromeOptions} from '../src/renderer.mjs';

await mkdir('artifacts',{recursive:true});
const dir=path.resolve('dist/demo'),p=JSON.parse(await readFile(path.join(dir,'project.json'),'utf8'));
let verified=0;
for(const a of p.assets){
 assert.equal(await fileHash(inside(dir,a.source)),a.sourceHash);
 for(const c of a.candidates.filter(c=>c.valid)){
  const file=inside(dir,c.file);assert.equal((await readFile(file)).length,c.bytes);
  assert.equal(await fileHash(file),c.hash);verified++;
 }
}
const base='/assetfit/',app=express();app.enable('strict routing');
app.get('/assetfit',(req,res)=>res.redirect(base));
app.use(base,express.static(path.resolve('dist')));
const server=http.createServer(app);
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({...await chromeOptions(),headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:1080},acceptDownloads:true}),errors=[],requests=[],responses=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(r.url().startsWith(origin))requests.push(new URL(r.url()).pathname);});
page.on('response',r=>responses.push({url:r.url(),status:r.status(),bodyBytes:Number(r.headers()['content-length']??0)}));
try{
 assert.equal((await fetch(origin+base+'api/health')).status,404);
 await page.goto(origin+'/assetfit');assert.equal(page.url(),origin+base);
 await page.getByText('Measured example archive.',{exact:false}).waitFor();
 await page.waitForLoadState('networkidle');
 const initialRequests=[...new Set(requests)],initialResponseBodyBytes=responses.reduce((s,r)=>s+r.bodyBytes,0);
 assert(!initialRequests.some(url=>url.endsWith('.glb')),'GLB files must load only after model selection');
 const candidatePaths=new Set(p.assets.flatMap(a=>a.candidates.map(c=>base+'demo/'+c.file)));
 const initialCandidateFiles=initialRequests.filter(url=>candidatePaths.has(url));
 assert(initialCandidateFiles.length<candidatePaths.size,'The initial view must not download every candidate');
 await page.screenshot({path:'artifacts/demo-desktop.png',fullPage:false});
 const selections=[];
 for(const budget of p.budgets){
  const expected=allocate(p.assets,budget.bytes);assert(expected.feasible);
  await page.locator(`[data-tier="${budget.name}"]`).click();
  assert((await page.locator('#exact-bytes').textContent()).includes(expected.bytes.toLocaleString()));
  selections.push({budget:budget.bytes,bytes:expected.bytes,selected:expected.selected});
 }
 await page.locator('[data-tier="standard"]').click();
 const glb=p.assets.find(a=>a.type==='glb');
 await page.locator(`[data-asset="${glb.id}"]`).click();
 await page.waitForFunction(()=>document.querySelectorAll('.view-stage canvas').length===2);
 await page.waitForLoadState('networkidle');
 await page.locator('.comparison').first().screenshot({path:'artifacts/demo-model-comparison.png'});
 const protectedImage=p.assets.find(a=>a.type==='image'&&a.constraints.lossless);
 if(protectedImage){
  await page.locator(`[data-asset="${protectedImage.id}"]`).click();
  await page.locator('#mode-actual').click();
  await page.locator('summary').filter({hasText:'Display conditions & hard constraints'}).click();
  assert(await page.locator('#lossless').isChecked());
  await page.locator('.comparison').first().screenshot({path:'artifacts/demo-protected-comparison.png'});
 }
 await page.locator(`[data-asset="${glb.id}"]`).click();
 await page.locator('[data-tier="lite"]').click();
 const budget=p.budgets.find(b=>b.name==='lite').bytes,before=allocate(p.assets,budget);
 await page.locator('#priority').selectOption('10');
 const weighted=structuredClone(p.assets);weighted.find(a=>a.id===glb.id).priority=10;
 const expected=allocate(weighted,budget);
 assert((await page.locator('#exact-bytes').textContent()).includes(expected.bytes.toLocaleString()));
 const downloadEvent=page.waitForEvent('download');await page.locator('#export').click();
 const download=await downloadEvent,file='artifacts/browser-delivery.zip';await download.saveAs(file);
 const zip=await JSZip.loadAsync(await readFile(file)),out=path.resolve('artifacts/browser-delivery');
 for(const entry of Object.values(zip.files).filter(e=>!e.dir)){
  const dest=inside(out,entry.name);await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,await entry.async('nodebuffer'));
 }
 const delivery=await verifyDelivery(out);assert(delivery.valid);assert.equal(delivery.assetBytes,expected.bytes);
 const manifest=JSON.parse(await zip.file('manifest.json').async('string'));
 const report=JSON.parse(await zip.file('report.json').async('string'));
 assert(report.precomputedCandidates);assert.deepEqual(report.allocation.selected,expected.selected);
 for(const a of p.assets){
  const c=a.candidates.find(c=>c.id===expected.selected[a.id]);
  const entry=manifest.assets.find(f=>f.id===a.id);assert.equal(entry.sha256,c.hash);assert.equal(entry.bytes,c.bytes);
  assert.deepEqual(report.assets.find(f=>f.id===a.id).candidate.params,c.params);
 }
 for(const license of p.demo?.licenses??['SOURCES.json','Duck-license.txt'])assert(zip.file('licenses/'+license.split('/').at(-1)));
 await page.screenshot({path:'artifacts/demo-export.png',fullPage:false});
 await page.locator('#budget').fill('1');await page.locator('#budget').dispatchEvent('change');
 await page.getByText('No feasible configuration found under current constraints and exploration budget.').waitFor();
 assert(await page.locator('#export').isDisabled());
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'artifacts/demo-mobile.png',fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert(requests.every(url=>url===base.slice(0,-1)||url.startsWith(base)),`Resources escaped the project subpath: ${requests.filter(url=>url!==base.slice(0,-1)&&!url.startsWith(base)).join(', ')}`);
 const badResponses=responses.filter(r=>r.status>=400&&!r.url.endsWith('/api/health'));
 assert.deepEqual(badResponses,[]);assert.deepEqual(errors,[]);
 const result={schemaVersion:1,staticBasePath:base,staticOriginHasNoProcessingAPI:true,verifiedCandidates:verified,
  archiveJsonBytes:(await readFile(path.join(dir,'project.json'))).length,
  initialResponseBodyBytes,initialCandidateFiles:initialCandidateFiles.length,totalDistinctCandidateFiles:candidatePaths.size,
  initialGlbFiles:0,modelLoadsAfterSelection:true,selections,
  priorityChangesActualSelection:JSON.stringify(before.selected)!==JSON.stringify(expected.selected),
  priorityResultMatchesAllocator:true,browserZip:delivery,browserZipBytes:(await readFile(file)).length,
  licensesIncluded:true,recipesMatchCandidates:true,tooSmallBudgetDisablesExport:true,mobileNoPageOverflow:true,browserErrors:errors};
 await writeFile('artifacts/demo-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
