import { mkdir, readFile, writeFile, copyFile, readdir, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createProject, importFiles, configure, optimize, persist, makeRecipe } from '../src/project.mjs';
import { allocate, allocateGreedy, allocateProportional } from '../src/allocator.mjs';
import { exportDelivery, verifyDelivery } from '../src/delivery.mjs';
import { createRenderer } from '../src/renderer.mjs';
import { GLB_PIPELINE_VERSION } from '../src/glb.mjs';
import { IMAGE_VERSION } from '../src/images.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'examples/release-config.json'), 'utf8'));
const sourceDir = path.join(root, 'examples/sources');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(root, 'artifacts/release-case', runId);
const demoDir = path.join(root, 'examples/release-demo');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(root, file).split(path.sep).join('/');
const json = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n'); };
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
const started = performance.now();
const stages = {};
await mkdir(runDir, { recursive: true });

async function prepareSources() {
  const file = path.join(root, 'examples/SOURCES.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const photo = {
    file: 'blue-marble.jpg', title: 'Blue Marble Earth, Apollo 17', author: 'NASA / Apollo 17 Crew',
    license: 'Public domain, United States government work; NASA media usage guidelines apply',
    source: 'https://apod.nasa.gov/apod/image/2202/bluemarble_apollo17_3000.jpg',
    attribution: 'https://apod.nasa.gov/apod/ap220206.html',
    individualSourcePage: 'https://www.nasa.gov/image-article/blue-marble-view-from-apollo-17/',
    licenseUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
    credit: 'NASA / Apollo 17 Crew. Source photograph AS17-148-22727, captured December 7, 1972.',
    usageNote: 'Used as a factual image-processing example with source attribution. No endorsement is asserted.',
    modifications: 'Official 3000-pixel JPEG retained exactly; candidates are encoded and resized under the recorded display constraints. No source upscaling or synthetic byte padding.',
    sha256: 'dfc341bd81efcb2d9a22aaee3f92e84b538c4501157b02e16b8dc93c4965f048',
    bytes: 1438327, width: 3000, height: 3002,
    snapshotVersion: 'sha256:dfc341bd81efcb2d9a22aaee3f92e84b538c4501157b02e16b8dc93c4965f048',
  };
  if (!manifest.assets.some(asset => asset.file === photo.file)) manifest.assets.push(photo);
  else manifest.assets = manifest.assets.map(asset => asset.file === photo.file ? photo : asset);
  for (const requested of config.assets) {
    const record = manifest.assets.find(asset => asset.file === requested.file);
    if (!record) throw new Error(`Missing individual provenance: ${requested.file}`);
    const location = path.join(sourceDir, requested.file);
    let bytes;
    try { bytes = await readFile(location); } catch (error) {
      if (error.code !== 'ENOENT' || !record.source.startsWith('https://')) throw error;
      const response = await fetch(record.source, { signal: controller.signal });
      if (!response.ok) throw new Error(`Source download failed: ${requested.file}: ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (sha(bytes) !== record.sha256) throw new Error(`Downloaded source differs from the pinned hash: ${requested.file}`);
      await writeFile(location, bytes, { flag: 'wx' });
    }
    if (sha(bytes) !== record.sha256 || bytes.length !== record.bytes) throw new Error(`Source hash/byte mismatch: ${requested.file}`);
  }
  manifest.recordedAt = new Date().toISOString();
  await json(file, manifest);
  return { ...manifest, assets: manifest.assets.filter(asset => config.assets.some(input => input.file === asset.file)) };
}

async function diskInventory(directory) {
  const result = { bytes: 0, files: 0, categories: {} };
  const walk = async (current, category = 'metadata') => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const location = path.join(current, entry.name);
      const group = current === directory && entry.isDirectory() ? entry.name : category;
      if (entry.isDirectory()) await walk(location, group);
      else if (entry.isFile()) {
        const bytes = (await stat(location)).size;
        result.bytes += bytes; result.files++;
        result.categories[group] ??= { bytes: 0, files: 0 };
        result.categories[group].bytes += bytes; result.categories[group].files++;
      }
    }
  };
  await walk(directory);
  return result;
}

function candidateCost(asset) {
  const totals = { candidateCount: asset.candidates.length, valid: 0, invalid: 0, proposalCount: 0,
    initializationMs: 0, encodeMs: 0, transformMs: 0, validationMs: 0, evaluationMs: 0, surrogateTrainingMs: 0, candidateWallMs: 0, cacheHits: 0 };
  for (const observation of asset.observations ?? []) {
    if (observation.event === 'proposal' || observation.phase === 'proposal') totals.proposalCount++;
    if (observation.event === 'initialization' || observation.phase === 'initialization') totals.initializationMs += observation.costMs ?? observation.durationMs ?? 0;
    if (observation.event === 'proposal') totals.surrogateTrainingMs += observation.trainingMs ?? 0;
    if (observation.event === 'resume-cache-hit' || observation.phase === 'cache-hit') totals.cacheHits++;
  }
  for (const candidate of asset.candidates) {
    totals[candidate.valid ? 'valid' : 'invalid']++;
    totals.candidateWallMs += candidate.costMs ?? 0;
    const costs = candidate.diagnostics?.timings ?? candidate.costs ?? {};
    totals.encodeMs += costs.encodeMs ?? 0; totals.transformMs += costs.transformMs ?? 0;
    totals.validationMs += costs.validationMs ?? 0; totals.evaluationMs += costs.evaluationMs ?? costs.evaluateMs ?? 0;
  }
  return totals;
}

function describeAllocation(project, allocation) {
  return { ...allocation, files: project.assets.map(asset => {
    const selected = asset.candidates.find(candidate => candidate.id === allocation.selected?.[asset.id]);
    return { assetId: asset.id, name: asset.name, usage: asset.usages[0].label, type: asset.type,
      candidateId: selected?.id ?? null, bytes: selected?.bytes ?? null, loss: selected?.metrics?.loss ?? null, sha256: selected?.hash ?? null };
  }) };
}

function allocationPlateau(project) {
  let combinations = [{ bytes: 0, loss: 0, selected: {} }];
  for (const asset of project.assets) {
    if (combinations.length * asset.candidates.length > 1_000_000) throw new Error('Release-case enumeration limit exceeded.');
    combinations = combinations.flatMap(prior => asset.candidates.filter(candidate => candidate.valid).map(candidate => ({
      bytes: prior.bytes + candidate.bytes, loss: prior.loss + asset.priority * candidate.metrics.loss,
      selected: { ...prior.selected, [asset.id]: candidate.id },
    })));
  }
  const current = project.allocations.high;
  const next = combinations.filter(choice => choice.loss < current.loss - 1e-12).sort((a, b) => a.bytes - b.bytes || a.loss - b.loss)[0];
  return { enumeratedConfigurations: combinations.length,
    sameStandardHigh: JSON.stringify(project.allocations.standard.selected) === JSON.stringify(current.selected),
    currentBytes: current.bytes, currentWeightedLoss: current.loss,
    nextImprovement: next ?? null, interpretation: 'The next threshold is computed from all combinations in this fixed measured table; no ungenerated candidate is implied.' };
}

async function buildDemo(projectDir, project, evidence, provenance, deliveries) {
  try { await stat(demoDir); await rename(demoDir, path.join(runDir, 'previous-release-demo')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.join(demoDir, 'media'), { recursive: true });
  const bySource = new Map();
  const copied = new Set();
  async function rewrite(value, key = '') {
    if (Array.isArray(value)) return Promise.all(value.map(item => rewrite(item, key)));
    if (value && typeof value === 'object') {
      const result = {};
      for (const [field, child] of Object.entries(value)) { if (field !== 'sourceKey') result[field] = await rewrite(child, field); }
      return result;
    }
    if (typeof value !== 'string') return value;
    const file = path.isAbsolute(value) ? value : path.resolve(projectDir, value);
    if (file.startsWith(projectDir + path.sep) && /\.(?:glb|png|webp|jpe?g)$/.test(file)) {
      if (bySource.has(file)) return bySource.get(file);
      try {
        const bytes = await readFile(file);
        const target = `media/${sha(bytes)}${path.extname(file).toLowerCase()}`;
        if (!copied.has(target)) { await writeFile(path.join(demoDir, target), bytes); copied.add(target); }
        bySource.set(file, target); return target;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (path.isAbsolute(value)) return path.basename(value);
    return value;
  }
  const demo = await rewrite(project);
  demo.precomputed = true;
  demo.demo = { title: 'Field Notes / Mixed visual collection',
    description: `A measured ${(project.assets.reduce((sum, asset) => sum + asset.sourceBytes, 0) / 1_000_000).toFixed(2)} MB collection with a product model, two real photographs, and an original-locked detail graphic.`,
    candidateGeneration: 'Actual local encoding and fixed-camera GLB search are precomputed. Budget and priority allocation run over the measured table in the browser.',
    cameraPolicy: 'Original-derived search cameras and separate final-check cameras are recorded. New camera conditions require the local program.',
    selectionRule: evidence.protocol.budgetRule, priorityExample: evidence.priorityComparison,
    storage: 'Identical media bytes share the demonstration cache only. Each physically delivered asset file remains independently charged by the allocator and manifest.',
    licenses: ['SOURCES.json'], downloads: {} };
  await mkdir(path.join(demoDir, 'downloads'), { recursive: true });
  for (const info of deliveries) {
    const location = path.join(projectDir, 'exports', info.exportId);
    const archive = info.budgetName === 'standard' ? 'downloads/standard.zip' : undefined;
    const report = `downloads/${info.budgetName}-report.json`;
    if (archive) await copyFile(path.join(projectDir, info.archive), path.join(demoDir, archive));
    for (const name of ['manifest', 'recipe', 'policy', 'report']) await copyFile(path.join(location, `${name}.json`), path.join(demoDir, 'downloads', `${info.budgetName}-${name}.json`));
    demo.demo.downloads[info.budgetName] = { archive, report, manifest: `downloads/${info.budgetName}-manifest.json`,
      recipe: `downloads/${info.budgetName}-recipe.json`, policy: `downloads/${info.budgetName}-policy.json`, prebuiltArchive: Boolean(archive),
      assetBytes: info.assetBytes, ...(archive ? { zipBytes: info.zipBytes } : {}), measuredLocalZipBytes: info.zipBytes,
      metadataBytes: info.metadataBytes, verified: info.verified };
  }
  demo.exports = deliveries.filter(info => info.budgetName === 'standard').map(info => ({ ...info, archive: demo.demo.downloads[info.budgetName].archive,
    report: demo.demo.downloads[info.budgetName].report }));
  await json(path.join(demoDir, 'project.json'), demo);
  await json(path.join(demoDir, 'evidence.json'), evidence);
  await json(path.join(demoDir, 'SOURCES.json'), provenance);
  await copyFile(path.join(root, 'examples/release-config.json'), path.join(demoDir, 'configuration.json'));
  await writeFile(path.join(demoDir, 'README.txt'), `AssetFit measured release case\n\nSource repository: https://github.com/yeopbong/assetfit\nOnline explorer: https://yeopbong.github.io/assetfit/\n\nTo process your own files locally, install Node.js 22.13+, pnpm 11.19.0 and Chrome or Playwright Chromium. Clone the repository, then run these commands on separate lines:\n\ngit clone https://github.com/yeopbong/assetfit.git\ncd assetfit\npnpm install --frozen-lockfile\npnpm build\npnpm start\n\nOpen http://127.0.0.1:4318 on the same computer. If Chrome is unavailable, run pnpm exec playwright install chromium. For an occupied port use pnpm start --port 4319. Quote a checkout path containing spaces. Tested local processing: macOS arm64 with Node 24.19.0, pnpm 11.19.0 and Chrome 152.0.7977.76. See the repository README and docs/RC.md for verification scope and limits.\n\nThis archive contains real source-derived candidate files and measured comparisons. Candidate generation is precomputed; the static browser application re-solves the recorded table and creates real ZIP downloads for any selected feasible budget. The four sources have individual attribution and licenses in SOURCES.json. No source bytes were inflated. The demonstration media cache may share identical files; exported asset files are independently counted.\n\nReproduce from the repository root: node scripts/release-case.mjs\nInputs, view conditions, protections, seed and three fixed budgets: examples/release-config.json\nDetailed outcome and accounting: docs/release-case.md and docs/release-case.json\n\nOnly downloads/standard.zip is included as a ready-made complete delivery. Every tier retains its manifest, recipe, policy and machine-readable report JSON. The other original local ZIPs and standalone HTML reports are not included in this archive. Download any feasible tier from the online explorer, or regenerate all tiers with pnpm release:case. Packaging does not modify any visual asset or quality measurement.\n\nThe 7,000,000-byte standard and 9,000,000-byte high budgets select the same files in this measured archive. Exhaustive enumeration of ${evidence.plateau.enumeratedConfigurations} combinations places the next strictly better weighted-loss combination at ${evidence.plateau.nextImprovement?.bytes.toLocaleString('en-US') ?? 'an unavailable'} bytes. Additional unused budget does not force a quality change.\n`);
  return { mediaFiles: copied.size, sourceReferencesRewritten: bySource.size, project: 'examples/release-demo/project.json', downloads: demo.demo.downloads };
}

const evidence = { schemaVersion: 1, runId, status: 'running', protocol: {
  budgetRule: 'Before candidate generation, declare lite = 5,500,000; standard = 7,000,000; high = 9,000,000 integer asset bytes. Budgets are not chosen from observed winning transitions.',
  sources: config.assets.map(asset => asset.file), config: 'examples/release-config.json',
  reproduction: 'node scripts/release-case.mjs', priorityBudget: config.priorityCheckBudget,
  priorityRule: 'At the fixed 8,500,000-byte budget compare balanced priorities, model priority 8, and Earth photo priority 8; record all outcomes even when selections do not change.',
  allocation: 'Exact sparse Pareto allocation over the same complete measured valid candidate table; compare greedy and proportional baselines with the same table and constraints.',
  retention: 'Each source is copied to a fresh managed project. Existing measured projects and the earlier small demonstration are retained.' },
  versions: { glb: GLB_PIPELINE_VERSION, image: IMAGE_VERSION, node: process.versions.node }, stages, projects: {} };
try {
  let stage = performance.now();
  const provenance = await prepareSources(); stages.sourceVerificationMs = performance.now() - stage;
  stage = performance.now();
  const { dir, project } = await createProject(path.join(runDir, 'projects'), config);
  const imported = await importFiles(dir, project, config.assets.map(asset => path.join(sourceDir, asset.file)));
  if (imported.failures.length) throw new Error(`Source import failed: ${JSON.stringify(imported.failures)}`);
  await configure(dir, project, { assets: project.assets.map(asset => ({ id: asset.id, ...config.assets.find(input => input.file === asset.name) })) });
  stages.importAndConfigurationMs = performance.now() - stage;
  stage = performance.now();
  await optimize(dir, project, { signal: controller.signal, onProgress: event => console.log(event.message) });
  stages.mainOptimizationMs = performance.now() - stage;
  if (project.status !== 'complete' || project.assets.some(asset => !asset.candidates.every(candidate => candidate.valid))) throw new Error(`Fresh release run did not complete with valid candidates: ${project.status}`);
  const model = project.assets.find(asset => asset.type === 'glb');
  const earth = project.assets.find(asset => asset.name === 'blue-marble.jpg');
  const protectedImage = project.assets.find(asset => asset.name === 'detail.png');
  if (protectedImage.candidates.length !== 1 || protectedImage.candidates[0].hash !== protectedImage.sourceHash) throw new Error('Original-locked detail image changed.');
  for (const asset of project.assets) for (const candidate of asset.candidates) {
    const data = await readFile(path.join(dir, candidate.file));
    if (data.length !== candidate.bytes || sha(data) !== candidate.hash) throw new Error('Candidate physical byte/hash check failed.');
  }
  stage = performance.now();
  evidence.allocations = config.budgets.map(budget => ({ budget, exact: describeAllocation(project, project.allocations[budget.name]),
    greedy: describeAllocation(project, allocateGreedy(project.assets, budget.bytes)),
    proportional: describeAllocation(project, allocateProportional(project.assets, budget.bytes)) }));
  const priority = { budget: config.priorityCheckBudget, modelAssetId: model.id, photoAssetId: earth.id,
    balanced: allocate(project.assets, config.priorityCheckBudget),
    favorModel: allocate(project.assets, config.priorityCheckBudget, { [model.id]: 8 }),
    favorPhoto: allocate(project.assets, config.priorityCheckBudget, { [earth.id]: 8 }) };
  evidence.priorityComparison = { ...priority,
    changedBothTypes: priority.favorModel.selected[model.id] !== priority.favorPhoto.selected[model.id]
      && project.assets.some(asset => asset.type === 'image' && priority.favorModel.selected[asset.id] !== priority.favorPhoto.selected[asset.id]),
    outcomes: Object.fromEntries(['balanced', 'favorModel', 'favorPhoto'].map(name => [name, describeAllocation(project, priority[name])])) };
  evidence.tinyBudgetCheck = describeAllocation(project, allocate(project.assets, 1_000_000));
  evidence.plateau = allocationPlateau(project);
  stages.baselineAndPriorityAllocationMs = performance.now() - stage;
  stage = performance.now();
  const deliveries = [];
  for (const budget of config.budgets) {
    if (!project.allocations[budget.name]?.feasible) throw new Error(`No release allocation was found for ${budget.name}.`);
    const info = await exportDelivery(dir, project, budget.name);
    const verified = await verifyDelivery(path.join(dir, 'exports', info.exportId));
    if (!verified.valid || verified.assetBytes !== info.assetBytes || (await stat(path.join(dir, info.archive))).size !== info.zipBytes) throw new Error('Independent delivery verification failed.');
    deliveries.push(info);
  }
  stages.exportAndVerificationMs = performance.now() - stage;
  stage = performance.now();
  const renderer = await createRenderer({ workDir: path.join(runDir, 'delivery-reload') });
  evidence.exportedFileReloads = [];
  try {
    const context = await renderer.reference(path.join(dir, model.source), model.usages);
    for (const delivery of deliveries) {
      const file = delivery.files.find(asset => asset.type === 'glb');
      const check = await renderer.evaluate(path.join(dir, 'exports', delivery.exportId, file.file), context, { heldout: true });
      const selected = model.candidates.find(candidate => candidate.id === file.candidateId);
      if (!check.valid || check.hash !== file.sha256 || Math.abs(check.loss - selected.finalCheck.loss) > 1e-9) throw new Error('Exported GLB changed under independent final-view reload.');
      evidence.exportedFileReloads.push({ tier: delivery.budgetName, hash: check.hash, bytes: check.bytes, valid: check.valid, stage: check.stage, loss: check.loss, durationMs: check.durationMs });
    }
  } finally { await renderer.close(); }
  stages.exportedFileReloadMs = performance.now() - stage;
  stage = performance.now();
  const locked = await createProject(path.join(runDir, 'projects'), { name: 'Release constraint check / all originals locked',
    budgets: [{ name: 'locked-lite', bytes: 5_500_000 }], settings: { maxEvaluations: 1, maxImageCandidates: 1, seed: 42, method: 'uniform', useSurrogate: false } });
  await importFiles(locked.dir, locked.project, config.assets.map(asset => path.join(sourceDir, asset.file)));
  await configure(locked.dir, locked.project, { assets: locked.project.assets.map(asset => ({ id: asset.id,
    usages: config.assets.find(input => input.file === asset.name).usages, constraints: { lockOriginal: true } })) });
  await optimize(locked.dir, locked.project, { signal: controller.signal });
  const lockAllocation = locked.project.allocations['locked-lite'];
  if (lockAllocation.feasible || locked.project.assets.some(asset => asset.candidates.length !== 1 || asset.candidates[0].hash !== asset.sourceHash)) throw new Error('Original-lock constraint failure check did not retain the actual originals.');
  let refusedExport = false;
  try { await exportDelivery(locked.dir, locked.project, 'locked-lite'); } catch (error) { refusedExport = /No feasible allocation/.test(error.message); }
  if (!refusedExport) throw new Error('Infeasible original-lock export was not refused.');
  evidence.lockCheck = { allocation: describeAllocation(locked.project, lockAllocation), refusedExport,
    assets: locked.project.assets.map(asset => ({ name: asset.name, sourceHash: asset.sourceHash, candidateHash: asset.candidates[0].hash, bytes: asset.candidates[0].bytes })) };
  stages.lockedProjectCheckMs = performance.now() - stage;
  evidence.projects.main = { directory: relative(dir), status: project.status, sourceBytes: project.assets.reduce((sum, asset) => sum + asset.sourceBytes, 0),
    settings: project.settings, environment: project.environment, cost: project.cost, disk: await diskInventory(dir),
    assets: project.assets.map(asset => ({ id: asset.id, name: asset.name, type: asset.type, sourceBytes: asset.sourceBytes, sourceHash: asset.sourceHash,
      usages: asset.usages, constraints: asset.constraints, costs: candidateCost(asset),
      candidates: asset.candidates.map(candidate => ({ id: candidate.id, bytes: candidate.bytes, hash: candidate.hash, valid: candidate.valid, loss: candidate.metrics.loss,
        params: candidate.params, dimensions: candidate.metadata, finalCheck: candidate.finalCheck ? { valid: candidate.finalCheck.valid, stage: candidate.finalCheck.stage, loss: candidate.finalCheck.loss } : null })) })) };
  evidence.projects.locked = { directory: relative(locked.dir), cost: locked.project.cost, disk: await diskInventory(locked.dir) };
  evidence.deliveries = deliveries.map(({ budgetName, assetBytes, metadataBytes, zipBytes, verified, exportId }) => ({ budgetName, assetBytes, metadataBytes, zipBytes, verified, directory: relative(path.join(dir, 'exports', exportId)) }));
  evidence.reallocation = { changedAcrossBudgets: new Set(Object.values(project.allocations).map(allocation => JSON.stringify(allocation.selected))).size > 1,
    modelCandidatesAcrossBudgets: config.budgets.map(budget => project.allocations[budget.name].selected[model.id]),
    imageCandidatesAcrossBudgets: project.assets.filter(asset => asset.type === 'image').map(asset => ({ name: asset.name, candidates: config.budgets.map(budget => project.allocations[budget.name].selected[asset.id]) })) };
  evidence.recipe = makeRecipe(project);
  evidence.status = 'complete';
  stage = performance.now();
  evidence.demo = await buildDemo(dir, project, evidence, provenance, deliveries);
  stages.demoAssemblyMs = performance.now() - stage;
  evidence.demo.disk = await diskInventory(demoDir);
  evidence.totalWallMs = performance.now() - started;
  evidence.costDefinition = 'Wall time is measured from script start through demonstration assembly, before final evidence/report serialization. Stage times include physical setup, encoding, evaluation and filesystem work. Project costs and candidate subcomponents are nested accounting views, not quantities to sum again. Demonstration cache and ZIP/container storage are separate from selected asset bytes.';
  for (let attempt = 0; attempt < 5; attempt++) {
    evidence.demo.disk = await diskInventory(demoDir);
    await json(path.join(demoDir, 'evidence.json'), evidence);
    if ((await diskInventory(demoDir)).bytes === evidence.demo.disk.bytes) break;
  }
  await json(path.join(root, 'examples/release-project.json'), { directory: relative(dir), runId, configuration: 'examples/release-config.json' });
  await json(path.join(root, 'docs/release-case.json'), evidence);
  await json(path.join(runDir, 'release-case.json'), evidence);
  const table = evidence.allocations.map(({ budget, exact, greedy, proportional }) => `| ${budget.name} | ${budget.bytes.toLocaleString('en-US')} | ${exact.bytes.toLocaleString('en-US')} | ${exact.normalizedLoss.toFixed(6)} | ${greedy.feasible ? greedy.normalizedLoss.toFixed(6) : 'No candidate combination'} | ${proportional.feasible ? proportional.normalizedLoss.toFixed(6) : 'No candidate combination'} |`).join('\n');
  const files = project.assets.map(asset => `| ${asset.name} | ${asset.usages.map(usage => `${usage.label}: ${usage.width} × ${usage.height} @ ${usage.dpr}`).join('; ')} | ${asset.sourceBytes.toLocaleString('en-US')} | ${asset.candidates.length} |`).join('\n');
  const exports = evidence.deliveries.map(info => `| ${info.budgetName} | ${info.assetBytes.toLocaleString('en-US')} | ${info.metadataBytes.toLocaleString('en-US')} | ${info.zipBytes.toLocaleString('en-US')} |`).join('\n');
  await writeFile(path.join(root, 'docs/release-case.md'), `# A measured mixed collection\n\nThis release case processes a ${(evidence.projects.main.sourceBytes / 1_000_000).toFixed(2)} MB collection in one project: Microsoft's CC0 Avocado model, a NASA editorial portrait, the NASA Apollo 17 Blue Marble photograph, and an original-locked detail graphic. The roles describe a constructed demonstration brief, not a customer case study. All files, scores, costs and downloads come from the fresh run recorded in [release-case.json](release-case.json).\n\n## Reproduce\n\nRun \`node scripts/release-case.mjs\` from the repository root after installing the documented dependencies and Chrome. [release-config.json](../examples/release-config.json) declares relative inputs, display sizes, protections, seed 42, twelve GLB observations, up to eight image candidates, and three budgets before generation. Each run creates a fresh managed project. The recipe in each delivery binds exact source hashes and asset mappings; it is distinct from a transferable policy.\n\nThe additional photo is credited to NASA / Apollo 17 Crew on its [official individual page](https://apod.nasa.gov/apod/ap220206.html), with provenance corroborated by [NASA's source article](https://www.nasa.gov/image-article/blue-marble-view-from-apollo-17/). Its usage follows [NASA's media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/), with attribution and no endorsement. The original JPEG is 3,000 × 3,002 pixels and 1,438,327 bytes; SHA-256 is \`dfc341bd81efcb2d9a22aaee3f92e84b538c4501157b02e16b8dc93c4965f048\`. [SOURCES.json](../examples/SOURCES.json) records every asset's individual author, license and hash. No input is upscaled or padded to inflate its byte count.\n\n## Uses and candidates\n\n| Asset | Declared uses | Original bytes | Actual candidates |\n| --- | --- | ---: | ---: |\n${files}\n\nThe portrait's two uses share one physical asset and one selected file. Usage weights are averaged within the asset. The model uses three original-derived search views; additional final views are evaluated only after allocation. Its normal and metallic-roughness images are retained. The detail graphic remains byte-identical to the original, including its transparency and full dimensions.\n\n## Joint allocation\n\nBudget sizes were fixed before generation. Each method below receives the same complete valid candidate table, protections and priorities. Lower proxy loss is better; it is not a visual-retention percentage.\n\n| Budget | Limit bytes | Exact selected bytes | Exact proxy loss | Greedy proxy loss | Proportional proxy loss |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${table}\n\nAt least one selection changes across the three budgets: **${evidence.reallocation.changedAcrossBudgets}**. The separately predefined 8,500,000-byte priority check changes both model and image choices between model priority 8 and Earth-photo priority 8: **${evidence.priorityComparison.changedBothTypes}**. All three priority outcomes are retained in the JSON, including unchanged choices. The standard/high equality is checked across all ${evidence.plateau.enumeratedConfigurations} combinations; the next strictly better weighted-loss combination costs ${evidence.plateau.nextImprovement?.bytes.toLocaleString('en-US') ?? 'an unavailable number of'} bytes. This is an exact optimum over this measured archive at each set of weights, not a claim about ungenerated encodings.\n\nA 1,000,000-byte allocation finds no feasible configuration in the measured archive. A separate fresh project locks all four originals, measures those four actual files, fails the 5,500,000-byte budget, and refuses export. No asset is removed and no lock is relaxed. The locked project is retained with its separate physical costs.\n\n## Delivery verification and accounting\n\nEvery tier's exported files are independently decoded or glTF-validated, byte-counted and hashed. Each exported GLB is also reloaded from its delivery path and rendered under the same final cameras; all three checks match their selected candidate measurements within 1e-9.\n\n| Tier | Visual asset bytes | Metadata bytes | Actual ZIP bytes |\n| --- | ---: | ---: | ---: |\n${exports}\n\nAsset bytes count selected visual files once per physical output. The independently generated ZIP and metadata are not included in that budget. 1 MB = 1,000,000 bytes; 1 MiB = 1,048,576 bytes.\n\nMeasured processing through demo assembly took ${(evidence.totalWallMs / 1000).toFixed(2)} seconds, including the separate lock-failure project, export reloads and demo assembly. Main-project optimization took ${(stages.mainOptimizationMs / 1000).toFixed(2)} seconds. Main managed-project files occupied ${evidence.projects.main.disk.bytes.toLocaleString('en-US')} logical filesystem bytes at the recorded inventory; the final assembled demo occupied ${evidence.demo.disk.bytes.toLocaleString('en-US')} bytes. Precise stage times, nested candidate transform/encode/validation/render/training costs, source copies, candidate storage, export storage and total file counts are recorded in JSON. These overlapping accounting views must not be summed twice.\n\nThe published demo includes a ready-made standard ZIP and each tier's manifest, recipe, policy and report JSON. All three verified ZIPs and standalone HTML reports remain in the original local project. The demo retains complete candidate records and real media files, and its browser can generate a fresh ZIP for any feasible allocation. Identical bytes share a content-addressed preview/archive cache to avoid duplicate storage; this does not create a cross-asset delivery deduction. The browser recomputes budget and priority allocation from precomputed observations. It cannot regenerate candidates or certify new camera conditions without the local program.\n`);
  console.log(JSON.stringify({ status: evidence.status, runId, sourceBytes: evidence.projects.main.sourceBytes,
    deliveries: evidence.deliveries, reallocation: evidence.reallocation, priorityChangesBothTypes: evidence.priorityComparison.changedBothTypes,
    totalSeconds: evidence.totalWallMs / 1000, demo: evidence.demo.project }, null, 2));
} catch (error) {
  evidence.status = controller.signal.aborted ? 'cancelled' : 'failed'; evidence.error = error.message; evidence.totalWallMs = performance.now() - started;
  await json(path.join(runDir, 'release-case.json'), evidence);
  throw error;
}
