import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {allocate} from '../src/allocator.mjs';

const require=createRequire(import.meta.url);
const {chromium}=require('playwright'),JSZip=require('jszip'),sharp=require('sharp'),validator=require('gltf-validator');
const fallbackOnly=process.argv.includes('--fallback-only');
const root=fileURLToPath(new URL('../',import.meta.url)),out=path.join(root,'artifacts',fallbackOnly?'public-fallback-verification':'public-verification');
const digest=data=>createHash('sha256').update(data).digest('hex');
if(!process.argv[2])throw new Error('Usage: node scripts/verify-public.mjs <https://host/project/> [--fallback-only]');
const site=new URL(process.argv[2]);
assert(['https:','http:'].includes(site.protocol)&&!site.username&&!site.password,'Use an HTTP(S) site URL without credentials.');
site.search='';site.hash='';if(!site.pathname.endsWith('/'))site.pathname+='/';
const archive=JSON.parse(await readFile(path.join(root,'examples/release-demo/project.json'),'utf8'));
const expectedPublic=structuredClone(archive);
for(const asset of expectedPublic.assets){delete asset.observations;delete asset.sourceKey;}delete expectedPublic.progress;
const expectedFiles=new Map();
for(const asset of archive.assets){
  expectedFiles.set(new URL('demo/'+asset.source,site).href,{hash:asset.sourceHash,bytes:asset.sourceBytes});
  for(const candidate of asset.candidates.filter(candidate=>candidate.valid))expectedFiles.set(new URL('demo/'+candidate.file,site).href,{hash:candidate.hash,bytes:candidate.bytes});
}
const candidateUrls=new Set(archive.assets.flatMap(asset=>asset.candidates.filter(candidate=>candidate.valid).map(candidate=>new URL('demo/'+candidate.file,site).href)));
async function browserOptions(){
  if(process.env.ASSETFIT_CHROME)return {executablePath:process.env.ASSETFIT_CHROME};
  const candidates=process.platform==='darwin'?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']:process.platform==='win32'?['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']:['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'];
  for(const executablePath of candidates)try{await access(executablePath);return {executablePath};}catch{}
  return {};
}
await mkdir(out,{recursive:true});
const proof={schemaVersion:1,site:site.href,checkedAt:new Date().toISOString(),status:'running',readOnlyRemoteActions:true,verificationMode:fallbackOnly?'recorded-render-fallback-only':'full-public-acceptance',
  scope:'Public page, live finite-table allocation, selected media and downloaded delivery. The remaining candidate files are not downloaded solely to increase a verification count.',
  localArchiveValidCandidates:archive.assets.reduce((sum,asset)=>sum+asset.candidates.filter(candidate=>candidate.valid).length,0)};
const browser=await chromium.launch({...await browserOptions(),headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:1080},acceptDownloads:true});
page.setDefaultTimeout(45_000);
const requests=[],responses=[],pageErrors=[],loadedFiles=new Map(),mediaChecks=[],mediaErrors=[];
page.on('pageerror',error=>pageErrors.push(error.message));
page.on('request',request=>requests.push({url:request.url(),method:request.method()}));
page.on('response',response=>{
  const url=response.url();responses.push({url,status:response.status()});
  if(response.status()!==200||!url.startsWith(new URL('demo/media/',site).href)||loadedFiles.has(url))return;
  loadedFiles.set(url,null);
  mediaChecks.push((async()=>{
    try{
      const bytes=await response.body(),expected=expectedFiles.get(url),filenameHash=new URL(url).pathname.match(/\/([a-f0-9]{64})\.[a-z0-9]+$/)?.[1];
      assert.equal(digest(bytes),expected?.hash??filenameHash,'Loaded media must match its recorded or content-addressed hash.');
      if(expected)assert.equal(bytes.length,expected.bytes,'Loaded source/candidate byte size must match the table.');
      if(url.endsWith('.glb'))assert.equal(bytes.subarray(0,4).toString(),'glTF');
      loadedFiles.set(url,{file:new URL(url).pathname.slice(site.pathname.length),bytes:bytes.length,sha256:digest(bytes),candidateOrSource:!!expected});
    }catch(error){mediaErrors.push({url,message:error.message});}
  })());
});
const selectionRecord=(name,assets,budget)=>({name,budget,...allocate(assets,budget)});
async function assertVisibleAllocation(expected,target=page){
  assert(expected.feasible);
  await target.waitForFunction(({bytes,budget})=>document.querySelector('#exact-bytes')?.textContent===`${bytes.toLocaleString()} / ${budget.toLocaleString()} actual asset bytes`,{bytes:expected.bytes,budget:expected.budget});
}
async function waitForModels(){
  await page.waitForFunction(()=>document.querySelectorAll('.view-stage canvas').length===2&&[...document.querySelectorAll('.view-stage canvas')].every(canvas=>canvas.width>0&&canvas.height>0));
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(()=>document.querySelectorAll('.view-stage canvas').length===2&&[...document.querySelectorAll('.view-stage canvas')].every(canvas=>{
    const gl=canvas.getContext('webgl2')??canvas.getContext('webgl');if(!gl||gl.isContextLost())return false;
    const pixel=new Uint8Array(4);
    for(const x of [.2,.35,.5,.65,.8])for(const y of [.2,.35,.5,.65,.8]){
      gl.readPixels(Math.floor(canvas.width*x),Math.floor(canvas.height*y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      if(pixel[3]>0)return true;
    }
    return false;
  }),null,{polling:'raf',timeout:45_000});
  assert.equal(await page.getByText('3D preview unavailable:',{exact:false}).count(),0);
}
async function verifyWebglFallback(){
  const context=await browser.newContext({viewport:{width:1440,height:1080}});
  await context.addInitScript(()=>{
    const getContext=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(name,...args){
      return /webgl/i.test(name)?null:getContext.call(this,name,...args);
    };
  });
  const fallbackPage=await context.newPage();fallbackPage.setDefaultTimeout(45_000);
  const fallbackRequests=[],fallbackResponses=[],errors=[],checks=[],media=new Map();
  fallbackPage.on('pageerror',error=>errors.push(error.message));
  fallbackPage.on('request',request=>fallbackRequests.push({url:request.url(),method:request.method()}));
  fallbackPage.on('response',response=>{
    const url=response.url();fallbackResponses.push({url,status:response.status()});
    if(response.status()!==200||!url.startsWith(new URL('demo/media/',site).href)||media.has(url))return;
    media.set(url,null);
    checks.push((async()=>{
      try{
        const bytes=await response.body(),expected=expectedFiles.get(url),filenameHash=new URL(url).pathname.match(/\/([a-f0-9]{64})\.[a-z0-9]+$/)?.[1];
        assert.equal(digest(bytes),expected?.hash??filenameHash,'Fallback media must match its recorded or content-addressed hash.');
        if(expected)assert.equal(bytes.length,expected.bytes);
        media.set(url,{file:new URL(url).pathname.slice(site.pathname.length),bytes:bytes.length,sha256:digest(bytes)});
      }catch(error){errors.push(error.message);}
    })());
  });
  try{
    const tableResponse=fallbackPage.waitForResponse(response=>response.url()===new URL('demo/project.json',site).href&&response.status()===200);
    const navigation=await fallbackPage.goto(site.href,{waitUntil:'domcontentloaded'});assert.equal(navigation.status(),200);
    assert.equal(digest(await(await tableResponse).body()),digest(Buffer.from(JSON.stringify(expectedPublic))));
    await fallbackPage.getByText('Measured example archive.',{exact:false}).waitFor();
    const tier=archive.budgets.find(budget=>budget.name==='standard')??archive.budgets[0],expected=selectionRecord(tier.name,archive.assets,tier.bytes);
    await fallbackPage.locator(`[data-tier="${tier.name}"]`).click();await assertVisibleAllocation(expected,fallbackPage);
    const model=archive.assets.find(asset=>asset.type==='glb');assert(model);
    const selected=model.candidates.find(candidate=>candidate.id===expected.selected[model.id]);assert(selected);
    const alternative=model.candidates.filter(candidate=>candidate.valid&&candidate.id!==selected.id).sort((a,b)=>a.bytes-b.bytes)[0];assert(alternative);
    async function checkRecordedImages(candidate){
      const reference=candidate.metrics?.reference??model.reference?.preview,preview=candidate.metrics?.preview;assert(reference&&preview);
      const originalUrl=new URL('demo/'+reference,site).href,resultUrl=new URL('demo/'+preview,site).href;
      await fallbackPage.waitForFunction(({originalUrl,resultUrl})=>{
        const original=document.querySelector('#original-view img'),result=document.querySelector('#result-view img');
        return original?.src===originalUrl&&result?.src===resultUrl&&original.complete&&result.complete&&original.naturalWidth>0&&result.naturalWidth>0;
      },{originalUrl,resultUrl});
      await fallbackPage.locator('#original-view img').evaluate(image=>image.decode());
      await fallbackPage.locator('#result-view img').evaluate(image=>image.decode());
      assert.equal(await fallbackPage.locator('#original-view img').getAttribute('alt'),'Recorded original render');
      assert.equal(await fallbackPage.locator('#result-view img').getAttribute('alt'),'Recorded candidate render');
      assert.match(await fallbackPage.locator('.compare-note').textContent(),/Interactive 3D preview unavailable:.*Showing recorded fixed-camera renders\./);
      assert.equal(await fallbackPage.locator('.view-stage canvas, #light').count(),0);
      assert(await fallbackPage.locator('#save-camera').isDisabled());
      await assertVisibleAllocation(expected,fallbackPage);
      assert.equal(await fallbackPage.locator('.candidate-table tr.chosen [data-candidate]').getAttribute('data-candidate'),selected.id);
      return {candidateId:candidate.id,reference,preview};
    }
    await fallbackPage.locator(`[data-asset="${model.id}"]`).click();
    const allocatedImages=await checkRecordedImages(selected);
    await fallbackPage.locator(`[data-candidate="${alternative.id}"]`).click();
    const inspectedImages=await checkRecordedImages(alternative);
    assert((await fallbackPage.locator('.comparison').first().textContent()).includes(alternative.id));
    await fallbackPage.waitForLoadState('networkidle');await Promise.all(checks);
    await fallbackPage.locator('.comparison').first().screenshot({path:path.join(out,'public-model-fallback.png')});
    assert.deepEqual(errors,[]);
    const httpRequests=fallbackRequests.filter(request=>/^https?:/.test(request.url)),healthUrl=new URL('api/health',site).href;
    assert(httpRequests.every(request=>request.method==='GET'&&request.url.startsWith(site.href)));
    assert(!httpRequests.some(request=>new URL(request.url).pathname.endsWith('.glb')),'WebGL failure before loader startup must use recorded images without downloading GLBs.');
    assert(fallbackResponses.some(response=>response.url===healthUrl&&response.status===404));
    assert.deepEqual(fallbackResponses.filter(response=>response.status>=400&&response.url!==healthUrl),[]);
    return {forcedWebglUnavailable:true,mode:'recorded-fixed-camera-images',interactive3D:false,asset:model.name,allocatedImages,inspectedImages,
      assetBytes:expected.bytes,budgetBytes:expected.budget,allocationUnchangedByInspection:true,imagesDecoded:true,saveViewDisabled:true,noInteractiveControls:true,
      noGlbDownloads:true,onlyGetRequests:true,projectSubpathRespected:true,noProcessingBackend:true,loadedMedia:[...media.values()].filter(Boolean),browserErrors:errors};
  }finally{await context.close();}
}
try{
  if(fallbackOnly){
    proof.webglFallback=await verifyWebglFallback();proof.status='passed';proof.browser=browser.version();
  }else{
  const tableUrl=new URL('demo/project.json',site).href;
  const tableResponse=page.waitForResponse(response=>response.url()===tableUrl&&response.status()===200);
  const navigation=await page.goto(site.href,{waitUntil:'domcontentloaded'});assert.equal(navigation.status(),200);
  const tableBytes=await(await tableResponse).body();
  assert.equal(digest(tableBytes),digest(Buffer.from(JSON.stringify(expectedPublic))),'The public candidate table must match this release checkout.');
  await page.getByText('Measured example archive.',{exact:false}).waitFor();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.getByText('STATIC EXPLORER',{exact:true}).count(),1);
  assert.equal(await page.locator('#run, #import, .progress').count(),0,'Static mode must not pretend to encode or process uploads.');
  const initialRequests=[...new Set(requests.map(request=>request.url))];
  assert(!initialRequests.some(url=>url.endsWith('.glb')),'Initial view must not download model files.');
  const initialCandidateFiles=initialRequests.filter(url=>candidateUrls.has(url)).length;
  assert(initialCandidateFiles<candidateUrls.size,'Initial view must not download every candidate.');
  proof.initial={tableBytes:tableBytes.length,tableSha256:digest(tableBytes),candidateFiles:initialCandidateFiles,totalCandidateFiles:candidateUrls.size,glbFiles:0};
  await page.screenshot({path:path.join(out,'public-overview.png')});

  proof.budgets=[];
  for(const budget of archive.budgets){
    const expected=selectionRecord(budget.name,archive.assets,budget.bytes);
    await page.locator(`[data-tier="${budget.name}"]`).click();await assertVisibleAllocation(expected);
    proof.budgets.push(expected);
  }
  const activeTier=archive.budgets.find(budget=>budget.name==='standard')??archive.budgets[0];
  await page.locator(`[data-tier="${activeTier.name}"]`).click();
  const model=archive.assets.find(asset=>asset.type==='glb');assert(model,'Mixed archive must include a GLB.');
  await page.locator(`[data-asset="${model.id}"]`).click();await waitForModels();
  const selected=allocate(archive.assets,activeTier.bytes).selected[model.id];
  const alternative=model.candidates.filter(candidate=>candidate.valid&&candidate.id!==selected).sort((a,b)=>a.bytes-b.bytes)[0];assert(alternative);
  await page.locator(`[data-candidate="${alternative.id}"]`).click();await waitForModels();
  assert((await page.locator('.comparison').first().textContent()).includes(alternative.id));
  await assertVisibleAllocation(selectionRecord(activeTier.name,archive.assets,activeTier.bytes));
  assert.equal(await page.locator('.candidate-table tr.chosen [data-candidate]').getAttribute('data-candidate'),selected,'Inspection must not silently change the allocation.');
  assert(requests.some(request=>request.url===new URL('demo/'+alternative.file,site).href));
  await page.locator('.comparison').first().screenshot({path:path.join(out,'public-model-comparison.png')});
  proof.modelComparison={asset:model.name,inspectedCandidate:alternative.id,allocationUnchangedByInspection:true,twoRenderedCanvases:true,nontransparentFramebufferPixelsVerified:true};

  const configuration=JSON.parse(await readFile(path.join(root,'examples/release-config.json'),'utf8'));
  const priorityBudget=configuration.priorityCheckBudget??activeTier.bytes;
  await page.locator('#budget').fill(String(priorityBudget));await page.locator('#budget').dispatchEvent('change');
  const weighted=structuredClone(archive.assets),baseline=selectionRecord('equal priorities',weighted,priorityBudget);
  await assertVisibleAllocation(baseline);
  await page.locator('#priority').selectOption('10');weighted.find(asset=>asset.id===model.id).priority=10;
  const modelPriority=selectionRecord('model priority 10',weighted,priorityBudget);await assertVisibleAllocation(modelPriority);await waitForModels();
  assert.equal(await page.locator('.candidate-table tr.chosen [data-candidate]').getAttribute('data-candidate'),modelPriority.selected[model.id]);
  await page.locator('#priority').selectOption('1');weighted.find(asset=>asset.id===model.id).priority=1;
  const photo=weighted.find(asset=>asset.type==='image'&&!asset.constraints.lockOriginal&&asset.name==='blue-marble.jpg')??weighted.find(asset=>asset.type==='image'&&!asset.constraints.lockOriginal);assert(photo);
  await page.locator(`[data-asset="${photo.id}"]`).click();await page.locator('#priority').selectOption('10');photo.priority=10;
  const expected=selectionRecord('photo priority 10',weighted,priorityBudget);await assertVisibleAllocation(expected);await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('.candidate-table tr.chosen [data-candidate]').getAttribute('data-candidate'),expected.selected[photo.id]);
  proof.priorities={baseline,model:modelPriority,photo:expected,changedBetweenPriorities:JSON.stringify(modelPriority.selected)!==JSON.stringify(expected.selected)};
  const locked=weighted.find(asset=>asset.constraints.lockOriginal);if(locked){
    await page.locator(`[data-asset="${locked.id}"]`).click();assert.equal(await page.locator('#protection').inputValue(),'lock');assert(await page.locator('#protection').isDisabled());
    assert.equal(expected.selected[locked.id],'original');
  }

  const downloadEvent=page.waitForEvent('download',{timeout:90_000});await page.locator('#export').click();
  const download=await downloadEvent,zipFile=path.join(out,'public-delivery.zip');await download.saveAs(zipFile);
  const zipBytes=await readFile(zipFile),zip=await JSZip.loadAsync(zipBytes);
  const manifest=JSON.parse(await zip.file('manifest.json').async('string')),report=JSON.parse(await zip.file('report.json').async('string')),recipe=JSON.parse(await zip.file('recipe.json').async('string'));
  assert.equal(report.precomputedCandidates,true);assert.equal(report.liveAllocation,true);assert.deepEqual(report.allocation.selected,expected.selected);
  assert.equal(manifest.assetBytes,expected.bytes);assert.equal(manifest.budgetBytes,priorityBudget);assert.equal(manifest.assets.length,weighted.length);
  let actualBytes=0;const files=[];
  for(const asset of weighted){
    const candidate=asset.candidates.find(candidate=>candidate.id===expected.selected[asset.id]),entry=manifest.assets.find(entry=>entry.id===asset.id);assert(entry);
    const bytes=await zip.file(entry.file).async('nodebuffer');actualBytes+=bytes.length;
    assert.equal(bytes.length,candidate.bytes);assert.equal(entry.bytes,candidate.bytes);assert.equal(digest(bytes),candidate.hash);assert.equal(entry.sha256,candidate.hash);
    assert.deepEqual(report.assets.find(entry=>entry.id===asset.id).candidate.params,candidate.params);
    const replay=recipe.assets.find(entry=>entry.id===asset.id);assert.equal(replay.sourceHash,asset.sourceHash);assert.equal(replay.selectedHashes[activeTier.name],candidate.hash);
    assert.deepEqual(replay.constraints,asset.constraints);assert.deepEqual(replay.usages,asset.usages);assert.equal(replay.priority,asset.priority);
    if(asset.type==='glb'){const validation=await validator.validateBytes(new Uint8Array(bytes),{maxIssues:100});assert.equal(validation.issues.numErrors,0);}
    else await sharp(bytes,{failOn:'error'}).raw().toBuffer();
    files.push({asset:asset.name,file:entry.file,bytes:bytes.length,sha256:digest(bytes),candidateId:candidate.id});
  }
  assert.equal(actualBytes,expected.bytes);assert(actualBytes<=priorityBudget);
  for(const license of archive.demo?.licenses??[])assert(zip.file('licenses/'+license.split('/').at(-1)),'Source license must accompany the delivery.');
  proof.delivery={assetBytes:actualBytes,budgetBytes:priorityBudget,zipBytes:zipBytes.length,zipSha256:digest(zipBytes),files,independentlyDecoded:true,recipesMatch:true,sourceLicensesIncluded:true};
  await page.screenshot({path:path.join(out,'public-export.png')});
  await page.locator('#budget').fill('1');await page.locator('#budget').dispatchEvent('change');
  await page.getByText('No feasible configuration found under current constraints and exploration budget.').waitFor();assert(await page.locator('#export').isDisabled());
  proof.tooSmallBudgetDisablesExport=true;
  await page.waitForLoadState('networkidle');await Promise.all(mediaChecks);assert.deepEqual(mediaErrors,[]);
  const healthUrl=new URL('api/health',site).href;
  assert(responses.some(response=>response.url===healthUrl&&response.status===404),'Public site must have no local processing backend.');
  const httpRequests=requests.filter(request=>/^https?:/.test(request.url));
  assert(httpRequests.every(request=>request.method==='GET'),'Verification must not mutate a remote service.');
  assert(httpRequests.every(request=>request.url.startsWith(site.href)),'Application resources must stay under the deployed project path.');
  assert.deepEqual(responses.filter(response=>response.status>=400&&response.url!==healthUrl),[]);assert.deepEqual(pageErrors,[]);
  proof.status='passed';proof.browser=browser.version();proof.noProcessingBackend=true;proof.onlyGetRequests=true;proof.projectSubpathRespected=true;
  proof.loadedMedia=[...loadedFiles.values()].filter(Boolean);proof.distinctPublicCandidateFilesLoaded=[...loadedFiles.keys()].filter(url=>candidateUrls.has(url)).length;proof.browserErrors=pageErrors;
  proof.webglFallback=await verifyWebglFallback();
  }
}catch(error){proof.status='failed';proof.error=error.message;throw error;}
finally{await browser.close();await writeFile(path.join(out,'result.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));}
