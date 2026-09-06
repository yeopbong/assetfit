import express from 'express';
import multer from 'multer';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,readdir,readFile,rm} from 'node:fs/promises';
import {createProject,loadProject,importFiles,configure,optimize,solve,persist,replaceCandidate} from './project.mjs';
import {exportDelivery} from './delivery.mjs';
import {uid,safeName,inside} from './util.mjs';
const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function serve({root=path.join(appRoot,'.assetfit/projects'),port=4318}={}){
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Choose a port between 1 and 65535, for example: pnpm start --port 4319');
 await mkdir(root,{recursive:true});const app=express(),jobs=new Map(),projects=new Map();
 app.disable('x-powered-by');app.use((req,res,next)=>{const host=req.headers.host??'';if(!new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`).test(host))return res.status(403).json({error:'Local host required'});if(req.headers.origin&&!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(req.headers.origin))return res.status(403).json({error:'Same-origin request required'});res.set('X-Content-Type-Options','nosniff');next();});
 app.use(express.json({limit:'256kb'}));
 async function get(id){if(!/^[a-zA-Z0-9-]+$/.test(id))throw new Error('Invalid project ID');if(!projects.has(id)){const dir=inside(root,id),p=await loadProject(dir);if(p.exporting){p.exporting=false;await persist(dir,p);}if(p.status==='running'){p.status='interrupted';for(const a of p.assets)if(a.status==='running')a.status='interrupted';await persist(dir,p);}projects.set(id,{dir,project:p});}return projects.get(id);}
 app.get('/api/health',(req,res)=>res.json({mode:'local',version:'0.1.0',processing:true}));
 app.get('/api/projects',async(req,res)=>{const rows=[];for(const id of await readdir(root)){try{const {project:p}=await get(id);rows.push({id:p.id,name:p.name,status:p.status,assets:p.assets.length,updatedAt:p.updatedAt});}catch{}}res.json(rows.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)));});
 app.post('/api/projects',async(req,res)=>{const data=await createProject(root,req.body);projects.set(data.project.id,data);res.json(data.project);});
 app.get('/api/projects/:id',async(req,res)=>res.json((await get(req.params.id)).project));
 app.patch('/api/projects/:id',async(req,res)=>{const {dir,project:p}=await get(req.params.id);await configure(dir,p,req.body);res.json(p);});
 const uploadDir=path.join(appRoot,'.assetfit/uploads');await mkdir(uploadDir,{recursive:true});
 const upload=multer({preservePath:true,storage:multer.diskStorage({destination:uploadDir,filename:(req,file,cb)=>cb(null,uid()+path.extname(safeName(file.originalname)))}),limits:{fileSize:100_000_000,files:40,fields:0}});
 app.post('/api/projects/:id/import',upload.array('files',40),async(req,res)=>{try{const {dir,project:p}=await get(req.params.id);if(jobs.has(p.id)||p.exporting)throw new Error('Processing or delivery export is running');await importFiles(dir,p,req.files.map(f=>f.path),{names:req.files.map(f=>f.originalname)});res.json(p);}finally{await Promise.all((req.files??[]).map(f=>rm(f.path,{force:true})));}});
 app.post('/api/projects/:id/sample',async(req,res)=>{const {dir,project:p}=await get(req.params.id);if(jobs.has(p.id)||p.exporting)throw new Error('Processing or delivery export is running');const sourceDir=path.join(appRoot,'examples/sources');const files=['Duck.glb','astronaut.png','detail.png'].map(f=>path.join(sourceDir,f));await importFiles(dir,p,files);res.json(p);});
 app.post('/api/projects/:id/run',async(req,res)=>{const {dir,project:p}=await get(req.params.id);if(jobs.has(p.id)||p.exporting)return res.status(409).json({error:'Already processing'});const controller=new AbortController();const job={controller,promise:null};jobs.set(p.id,job);p.status='running';res.json({started:true});job.promise=optimize(dir,p,{signal:controller.signal,onProgress:event=>{p.progress=event;}}).catch(e=>{p.error=e.message;}).finally(()=>jobs.delete(p.id));});
 app.post('/api/projects/:id/cancel',async(req,res)=>{jobs.get(req.params.id)?.controller.abort();res.json({cancelling:jobs.has(req.params.id)});});
 app.post('/api/projects/:id/solve',async(req,res)=>{const {dir,project:p}=await get(req.params.id);if(jobs.has(p.id)||p.exporting)throw new Error('Processing or delivery export is running');await solve(dir,p);res.json(p);});
 app.post('/api/projects/:id/choice',async(req,res)=>{const {dir,project:p}=await get(req.params.id);await replaceCandidate(dir,p,req.body.budgetName,req.body.assetId,req.body.candidateId);res.json(p);});
 app.post('/api/projects/:id/export',async(req,res)=>{const {dir,project:p}=await get(req.params.id);if(jobs.has(p.id)||p.exporting)throw new Error('Processing or delivery export is running');p.exporting=true;try{const result=await exportDelivery(dir,p,req.body.budgetName);res.json(result);}finally{p.exporting=false;await persist(dir,p);}});
 app.use('/files/:id',async(req,res,next)=>{try{const {dir}=await get(req.params.id);express.static(dir,{dotfiles:'deny',index:false})(req,res,next);}catch(e){next(e);}});
 app.use(express.static(path.join(appRoot,'dist')));
 app.use((err,req,res,next)=>{if(res.headersSent)return next(err);res.status(400).json({error:err.message});});
 const server=await new Promise((resolve,reject)=>{
  const listener=createServer(app);
  listener.once('error',error=>reject(error.code==='EADDRINUSE'
   ?new Error(`Port ${port} is already in use. Open the existing workspace, stop its process, or choose another port: pnpm start --port ${port<65535?port+1:4318}`)
   :error));
  listener.listen(port,'127.0.0.1',()=>resolve(listener));
 });
 console.log(`AssetFit local workspace: http://127.0.0.1:${port}`);
 return {server,jobs,close:async()=>{for(const job of jobs.values())job.controller.abort();await Promise.allSettled([...jobs.values()].map(job=>job.promise));await new Promise(resolve=>server.close(resolve));}};
}
