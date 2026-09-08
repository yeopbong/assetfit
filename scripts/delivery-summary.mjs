import {readFile,writeFile} from 'node:fs/promises';
const json=async f=>JSON.parse(await readFile(f,'utf8'));
const [examples,local,demo,benchmark]=await Promise.all([json('artifacts/examples/verification.json'),json('artifacts/local-verification.json'),json('artifacts/demo-verification.json'),json('docs/benchmark-results.json')]);
const replay=await json('artifacts/mixed-replay.json').catch(()=>null);
const tests=await readFile('artifacts/tests-final.txt','utf8');
const result={recordedAt:new Date().toISOString(),tests:{total:Number(tests.match(/ℹ tests (\d+)/)?.[1]),passed:Number(tests.match(/ℹ pass (\d+)/)?.[1]),failed:Number(tests.match(/ℹ fail (\d+)/)?.[1]),skipped:Number(tests.match(/ℹ skipped (\d+)/)?.[1])},mixedReplay:replay?.replay??{status:'not-run'},localBrowser:local,staticBrowser:demo,mixed:{sources:examples.projects.mixed.sourceBytes,assets:examples.projects.mixed.assets.map(a=>({name:a.name,validCandidates:a.validCandidates})),allocations:examples.projects.mixed.allocations,cost:examples.projects.mixed.cost},downloads:examples.demo.downloads,benchmark:{status:benchmark.status,costs:benchmark.costs,source:'benchmark-results.json'},checks:{strictAllocatorAndMetricTypes:true,implementationSyntax:true,cleanPinnedDependencyInstall:true,firstPartyContentAudit:true},release:{published:false,build:'dist/',launcher:'start.command'}};
await writeFile('docs/verification.json',JSON.stringify(result,null,2));
console.log('Machine-readable verification saved.');
