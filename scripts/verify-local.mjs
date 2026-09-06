import {serve} from '../src/server.mjs';
import {chromium} from 'playwright';
import {chromeOptions} from '../src/renderer.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import JSZip from 'jszip';
import {inside} from '../src/util.mjs';
import {verifyDelivery} from '../src/delivery.mjs';
await mkdir('artifacts',{recursive:true});
const instance=await serve({port:4329,root:path.resolve('artifacts/browser-projects')}),browser=await chromium.launch({...await chromeOptions(),headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
let page=await browser.newPage({viewport:{width:1440,height:1080},acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));const origin='http://127.0.0.1:4329';
try{
 await page.goto(origin);await page.locator('#new-project').click();await page.getByText('Start with your visual assets').waitFor();await page.locator('#sample').click();await page.waitForFunction(()=>document.querySelectorAll('.asset').length===3);
 await page.locator('#budget').fill('200000');const runEvent=page.waitForResponse(r=>r.url().endsWith('/run')&&r.request().method()==='POST');await page.locator('#run').click();await runEvent;
 const projectId=await page.evaluate(()=>document.querySelector('#history').value);assert(projectId);
 await page.close();
 const finished=await (async()=>{for(let i=0;i<120;i++){const p=await(await fetch(origin+'/api/projects/'+projectId)).json();if(['complete','failed','partial'].includes(p.status))return p;await new Promise(r=>setTimeout(r,500));}throw new Error('Local processing timed out');})();
 assert.equal(finished.status,'complete');assert.equal(finished.assets.length,3);assert(finished.allocations.standard.feasible);assert(finished.assets.every(a=>a.candidates.filter(c=>c.valid).length>=2));
 page=await browser.newPage({viewport:{width:1440,height:1080},acceptDownloads:true});page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.locator('#history').selectOption(projectId);await page.locator('#budget').fill('100000');
 const downloadEvent=page.waitForEvent('download');await page.locator('#export').click();const download=await downloadEvent;await download.saveAs('artifacts/local-ui-delivery.zip');const zip=await JSZip.loadAsync(await readFile('artifacts/local-ui-delivery.zip'));const manifest=JSON.parse(await zip.file('manifest.json').async('string'));assert.equal(manifest.budgetBytes,100000);assert(manifest.assetBytes<=100000);assert(zip.file('licenses/Duck-license.txt'));assert(zip.file('report.html'));
 const out=path.resolve('artifacts/local-ui-delivery');for(const entry of Object.values(zip.files).filter(e=>!e.dir)){const file=inside(out,entry.name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,await entry.async('nodebuffer'));}assert((await verifyDelivery(out)).valid);
 await page.locator('.asset').nth(0).click();await page.locator('summary').filter({hasText:'Display conditions & hard constraints'}).click();await page.locator('.object-lock').first().check();const savedEvent=page.waitForResponse(r=>r.url().endsWith('/api/projects/'+projectId)&&r.request().method()==='PATCH');await page.locator('#save-usage').click();await savedEvent;await page.waitForFunction(()=>document.querySelector('#export').disabled);const saved=await(await fetch(origin+'/api/projects/'+projectId)).json();assert(saved.assets[0].protection.affectedObjects.length>0);assert.equal(saved.assets[0].status,'stale');assert(await page.locator('#export').isDisabled());
 await page.screenshot({path:'artifacts/local-workspace.png',fullPage:true});assert.deepEqual(errors,[]);
 const result={projectId,closedPageTaskCompleted:true,assetTypes:finished.assets.map(a=>a.type),validCandidates:finished.assets.map(a=>({name:a.name,count:a.candidates.filter(c=>c.valid).length})),immediateBudgetExport:{requestedBudget:100000,actualAssetBytes:manifest.assetBytes,zipBytes:(await readFile('artifacts/local-ui-delivery.zip')).length},lockPropagationVisible:true,staleExportDisabled:true,browserErrors:errors};await writeFile('artifacts/local-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(e){console.log('Local verification failure:',e.message);if(!page.isClosed())await page.screenshot({path:'artifacts/local-failure.png',fullPage:true});if(!page.isClosed())console.log((await page.locator('.notice.error').allTextContents()));throw e;}finally{await browser.close();await new Promise(r=>instance.server.close(r));}
