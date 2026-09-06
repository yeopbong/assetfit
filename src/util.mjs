import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
export const VERSION='assetfit-0.1.0';
export const hash=data=>createHash('sha256').update(data).digest('hex');
export const fileHash=async file=>hash(await readFile(file));
export const uid=()=>randomUUID().slice(0,12);
export const safeName=value=>String(value).normalize('NFKC').replace(/[^a-zA-Z0-9._-]/g,'_').replace(/^\.+/,'').slice(0,100)||'asset';
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function saveJson(file,data){await mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${uid()}.tmp`;await writeFile(tmp,JSON.stringify(data,null,2));await rename(tmp,file);}
export function inside(root,relative){const resolved=path.resolve(root,relative);if(resolved!==path.resolve(root)&&!resolved.startsWith(path.resolve(root)+path.sep))throw new Error('Path outside managed project');return resolved;}
export function abort(signal){if(signal?.aborted)throw Object.assign(new Error('Processing cancelled; measured candidates were preserved.'),{name:'AbortError'});}
export function checkBudget(value){if(!Number.isSafeInteger(value)||value<0)throw new Error('Budget must be a nonnegative safe integer in bytes.');return value;}
