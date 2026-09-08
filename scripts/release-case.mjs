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
  await writeFile(path.join(demoDir, 'README.txt'), "AssetFit sample archive\n\nOnline explorer: https://yeopbong.github.io/assetfit/\nSource: https://github.com/yeopbong/assetfit\n\nThis archive contains precomputed candidates and comparisons. The browser selects from them and generates ZIP downloads. Use the local application for new files:\n\ngit clone https://github.com/yeopbong/assetfit.git\ncd assetfit\npnpm install --frozen-lockfile\npnpm build\npnpm start\n\nRequires Node.js 22.13+, pnpm 11.19.0 and Chrome or Playwright Chromium for GLB processing. Open http://127.0.0.1:4318. If needed, run pnpm exec playwright install chromium or use pnpm start --port 4319.\n\nSOURCES.json records asset attribution and licenses. Budgets count selected asset bytes; ZIP and metadata add overhead. downloads/standard.zip is ready to use. Other tiers retain JSON reports and recipes; download their ZIPs through the explorer.\n\nTo regenerate the sample, run pnpm release:case. Configuration: examples/release-config.json. Saved results: docs/release-case.json.\n");
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
  await writeFile(path.join(root, 'docs/release-case.md'), "# Mixed example\n\nThe sample combines the Avocado model, NASA astronaut and Blue Marble photographs, and a protected detail graphic. Source attribution and licenses are in [examples/SOURCES.json](../examples/SOURCES.json).\n\nOpen the [online explorer](https://yeopbong.github.io/assetfit/) to change the budget, compare candidates and download a selection. The portrait has two display uses but one physical output. The detail graphic is locked to its original bytes. The standard and high budgets select the same files in the saved candidate table.\n\nTo generate a new local run after installing dependencies and a rendering browser:\n\n```sh\npnpm release:case\n```\n\n[release-config.json](../examples/release-config.json) supplies input paths, display sizes, protections, seed and budgets. Each run creates a new managed project. [release-case.json](release-case.json) contains the saved candidates, allocations, baseline comparisons, failures, timings and delivery byte counts.\n\nThe static archive includes a standard ZIP and every tier's manifest, recipe, policy and JSON report. Use the explorer to generate another feasible ZIP. Budgets count selected visual files; ZIP and report bytes are separate.\n");
  console.log(JSON.stringify({ status: evidence.status, runId, sourceBytes: evidence.projects.main.sourceBytes,
    deliveries: evidence.deliveries, reallocation: evidence.reallocation, priorityChangesBothTypes: evidence.priorityComparison.changedBothTypes,
    totalSeconds: evidence.totalWallMs / 1000, demo: evidence.demo.project }, null, 2));
} catch (error) {
  evidence.status = controller.signal.aborted ? 'cancelled' : 'failed'; evidence.error = error.message; evidence.totalWallMs = performance.now() - started;
  await json(path.join(runDir, 'release-case.json'), evidence);
  throw error;
}
