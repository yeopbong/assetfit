import {build} from 'esbuild';
import {mkdir,copyFile,cp,rm,access,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
await mkdir('dist',{recursive:true});
const bundle=await build({entryPoints:['web/app.mjs'],outfile:'dist/app.js',bundle:true,format:'esm',minify:true,sourcemap:true,target:'es2022',metafile:true});
const packages=new Map();
for(const input of Object.keys(bundle.metafile.inputs).filter(file=>file.includes('node_modules/'))){
 let folder=path.dirname(path.resolve(input));
 while(folder!==path.dirname(folder)){
  try{const meta=JSON.parse(await readFile(path.join(folder,'package.json'),'utf8'));packages.set(meta.name,{folder,meta});break;}catch{folder=path.dirname(folder);}
 }
}
const notices=['AssetFit browser bundle — third-party notices\nJSZip is used under its MIT option. Sample assets have separate licenses in demo/SOURCES.json.'];
// JSZip's browser entry is itself a bundle, so esbuild cannot see its inner packages.
// Include its locked production dependency closure as well as visible bundle inputs.
async function includeDependencies(entry){
 const require=createRequire(path.join(entry.folder,'package.json'));
 for(const name of Object.keys(entry.meta.dependencies??{})){
  if(packages.has(name))continue;
  const file=require.resolve(name+'/package.json'),meta=JSON.parse(await readFile(file,'utf8'));
  const dependency={folder:path.dirname(file),meta};packages.set(name,dependency);await includeDependencies(dependency);
 }
}
if(packages.has('jszip'))await includeDependencies(packages.get('jszip'));
for(const {folder,meta} of [...packages.values()].sort((a,b)=>a.meta.name.localeCompare(b.meta.name))){
 notices.push(`\n${meta.name} ${meta.version} — ${meta.license??'See license text'}\n`);
 const files=(await readdir(folder)).filter(name=>/^(license|copying|notice)/i.test(name));
 for(const file of files)notices.push(await readFile(path.join(folder,file),'utf8'));
 if(!files.length){
  const readme=(await readdir(folder)).find(name=>/^readme(?:\.md)?$/i.test(name));
  const license=readme?(await readFile(path.join(folder,readme),'utf8')).match(/^##? License\s*$[\s\S]*/im)?.[0]:null;
  if(!license)throw new Error(`Missing bundled license for ${meta.name}; inspect before distributing.`);
  notices.push(license);
 }
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt',notices.join('\n'));
await Promise.all(['index.html','style.css'].map(f=>copyFile('web/'+f,'dist/'+f)));
await rm('dist/demo',{recursive:true,force:true});
let archive='examples/release-demo';
try{await access(archive+'/project.json');}catch{archive='examples/demo';}
await cp(archive,'dist/demo',{recursive:true});
const project=JSON.parse(await readFile('dist/demo/project.json','utf8'));
// Detailed observations remain in the archive; the explorer needs the candidate table only.
for(const asset of project.assets){delete asset.observations;delete asset.sourceKey;}
delete project.progress;
await writeFile('dist/demo/project.json',JSON.stringify(project));
await writeFile('dist/.nojekyll','');
console.log('Static build ready in dist. Candidate generation runs in the local service.');
