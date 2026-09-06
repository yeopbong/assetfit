import {readFile,writeFile} from 'node:fs/promises';
const json=async f=>JSON.parse(await readFile(f,'utf8'));
const [examples,local,demo,benchmark]=await Promise.all([json('artifacts/examples/verification.json'),json('artifacts/local-verification.json'),json('artifacts/demo-verification.json'),json('docs/benchmark-results.json')]);
const replay=await json('artifacts/mixed-replay.json').catch(()=>null);
const tests=await readFile('artifacts/tests-final.txt','utf8');
const result={recordedAt:new Date().toISOString(),tests:{total:Number(tests.match(/ℹ tests (\d+)/)?.[1]),passed:Number(tests.match(/ℹ pass (\d+)/)?.[1]),failed:Number(tests.match(/ℹ fail (\d+)/)?.[1]),skipped:Number(tests.match(/ℹ skipped (\d+)/)?.[1])},mixedReplay:replay?.replay??{status:'not-run'},localBrowser:local,staticBrowser:demo,mixed:{sources:examples.projects.mixed.sourceBytes,assets:examples.projects.mixed.assets.map(a=>({name:a.name,validCandidates:a.validCandidates})),allocations:examples.projects.mixed.allocations,cost:examples.projects.mixed.cost},downloads:examples.demo.downloads,benchmark:{status:benchmark.status,costs:benchmark.costs,source:'benchmark-results.json'},checks:{strictAllocatorAndMetricTypes:true,implementationSyntax:true,cleanPinnedDependencyInstall:true,firstPartyContentAudit:true},release:{published:false,build:'dist/',launcher:'start.command'}};
await writeFile('docs/verification.json',JSON.stringify(result,null,2));
const rows=Object.entries(result.downloads).map(([name,d])=>`| ${name} | ${d.assetBytes.toLocaleString('en-US')} | ${d.zipBytes.toLocaleString('en-US')} |`).join('\n');
await writeFile('docs/DELIVERY.md',`# AssetFit delivery record

AssetFit's local workflow is operational: import a mixed project, declare usage and protection, measure actual candidates, allocate a single asset-byte budget, inspect synchronized 3D and image comparisons, and export independently verified files with replay records.

## Start and outputs

- Run \`./start.command\` from the project directory, or use \`pnpm start\` after the installation/build commands in the README. The service binds to \`127.0.0.1:4318\`.
- \`dist/\` is a standalone static demonstration build. It serves a measured archive and recalculates allocation in the browser, with actual downloadable files. Serve it over HTTP; direct file URLs are not supported.
- \`examples/demo/downloads/\` contains the three verified example ZIPs and standalone visual reports.
- CLI inspection, optimization, configuration, allocation, manual-choice replay, export, policy reuse and delivery verification use the same project engine.
- No repository push, account creation, public deployment or resource upload was performed.

## Recorded verification

${result.tests.passed}/${result.tests.total} tests passed with ${result.tests.skipped} skipped, including actual Chrome rendering and persisted GLB cancellation/resume. The allocator was compared against exhaustive enumeration on 300 fixed-seed small tables. Strict checking covers the real allocator and metric implementations; syntax checks cover application, renderer, scripts and tests. A separate clean pinned installation verified Sharp encoding, esbuild, NodeIO and mesh simplification.

${replay?.replay?.consistent?`A complete CLI replay of the exported mixed recipe rebuilt all three budget tiers: ${replay.replay.checks.filter(c=>c.match).length}/${replay.replay.checks.length} selected-file SHA256 checks matched exactly in the recorded environment.`:'A complete mixed CLI replay was not recorded for this report.'}

The browser workflow processed a GLB and two images after its page was closed. An immediate budget edit before export produced **${local.immediateBudgetExport.actualAssetBytes.toLocaleString('en-US')} asset bytes under ${local.immediateBudgetExport.requestedBudget.toLocaleString('en-US')} bytes**. Shared-object protection was disclosed and stale exports were disabled. The local and static browser checks reported no uncaught page errors.

The independent static server had no processing API. It verified ${demo.verifiedCandidates} measured candidates, actual budget and priority redistribution, downloadable ZIP contents and licenses, and a 390-pixel-wide layout without page overflow.

## Real mixed example

The original mixed project contains 966,966 bytes: Sony's Duck model, a NASA portrait and a purpose-built detail-sheet constraint fixture. It has 12 valid GLB candidates, 8 photographic candidates and 3 strictly lossless detail candidates. See [asset-specific provenance](../examples/SOURCES.json).

| Tier | Selected asset bytes | Actual ZIP bytes |
| --- | ---: | ---: |
${rows}

ZIP sizes include metadata, embedded comparison figures and licenses. They are deliberately reported separately from the visual-resource budget. The detail-sheet output remains pixel-identical; budget and priority changes redistribute bytes between the model and photograph. All results come from actual source-derived files.

Image-only and Avocado-only projects were also processed and independently exported. The latest Avocado delivery contains 4,961,392 asset bytes under its 4,978,800-byte budget. Normal/ORM data images remain unchanged.

## Search findings

The fixed protocol evaluated 222 valid GLB candidates across two real models, three seeds and five configurations. The ridge surrogate uses measured observations only to propose subsequent real evaluations. It improved the evolutionary method on Avocado, while measured greedy achieved the best mean benchmark objective there. Duck tied on the reported scalar best. The first run exposed a UV component-stride bug; its failures are preserved, and the corrected full protocol was rerun. [Protocol, complete results and limits](benchmark-notes.md) document this without a universal performance claim.

The benchmark used GLB pipeline 1.0.1. The release's 1.0.2 patch preserves additional raw JSON annotations; byte equality was checked for the benchmark models' uniform outputs, and the release example/archive and regression tests use the current pipeline.

## Practical limits

The score is a declared display-space engineering difference, not aesthetic quality or a perceptual percentage. Geometry is checked at fixed original-derived cameras with separate post-selection views; arbitrary lighting and angles are not guaranteed. Exact original/object locks and decoded-image lossless requirements enforce explicit preservation.

Supported inputs are static 8-bit JPEG/PNG/WebP and self-contained core PBR triangle GLBs with optional texture transforms. Animation, skins, morphs, decoder-dependent extensions and unsupported metadata mappings are rejected rather than removed. Normal/ORM and alpha-sensitive GLB images are kept intact. There is no sprite rearrangement, cropping of output files or generative processing.

Candidate archives are finite. Exact allocation applies only to the current measured table; resource-cap failures are not claims of global infeasibility. Defaults limit source counts/sizes, rendering rasters, serial processing, managed storage and solver state growth. These limits are listed in the README. Browser/encoder changes may require a new measurement archive; source-bound replay reports hash mismatches without overwriting previous products.

The recorded example cost is cumulative and includes subsequent cache verification and post-selection reruns. It is not a single fresh-run benchmark; detailed stage fields can overlap and should not all be summed. [Machine-readable verification](verification.json) retains the actual ledgers.
`);
console.log('Delivery report and machine-readable verification saved.');
