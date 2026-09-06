import { mkdir, readFile, writeFile, copyFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import sharp from 'sharp';
import JSZip from 'jszip';
import { createProject, importFiles, optimize, solve, persist, loadProject } from '../src/project.mjs';
import { allocate, allocateGreedy, allocateProportional } from '../src/allocator.mjs';
import { exportDelivery, verifyDelivery } from '../src/delivery.mjs';
import { createRenderer } from '../src/renderer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'examples/sources');
const artifacts = path.join(root, 'artifacts/examples');
const demoDir = path.join(root, 'examples/demo');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const json = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2)); };
const relative = (file) => path.relative(root, file);

async function makeDetailSheet() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="480" viewBox="0 0 960 480">
  <defs><linearGradient id="g"><stop stop-color="#152736"/><stop offset="1" stop-color="#294d5e"/></linearGradient></defs>
  <rect x="12" y="12" width="936" height="456" rx="26" fill="url(#g)"/>
  <circle cx="112" cy="106" r="45" fill="#eabe7c"/><path d="M88 110h48M112 86v48" stroke="#18323e" stroke-width="8"/>
  <g fill="#f3eee5" font-family="Arial,sans-serif"><text x="183" y="103" font-size="33" font-weight="700">FIELD NOTES / 001</text>
  <text x="183" y="135" font-size="19" fill="#bbd0d4">A small visual collection, ready to travel.</text>
  <text x="62" y="222" font-size="19">MODEL</text><text x="352" y="222" font-size="19">PHOTOGRAPH</text><text x="642" y="222" font-size="19">DETAIL SHEET</text>
  <text x="62" y="268" font-size="28" font-weight="700">Static GLB</text><text x="352" y="268" font-size="28" font-weight="700">NASA archive</text><text x="642" y="268" font-size="28" font-weight="700">Original pixels</text>
  <text x="62" y="318" font-size="17" fill="#bbd0d4">Turntable at 256 px</text><text x="352" y="318" font-size="17" fill="#bbd0d4">Portrait at 320 px</text><text x="642" y="318" font-size="17" fill="#bbd0d4">Lossless · full dimensions</text>
  <text x="62" y="417" font-size="17">ASSET BYTES = selected visual files, counted once per physical output.</text></g>
  <path d="M62 353h835" stroke="#63828e"/><g fill="#eabe7c"><rect x="64" y="365" width="8" height="8"/><rect x="78" y="365" width="8" height="8"/><rect x="92" y="365" width="8" height="8"/></g></svg>`;
  await mkdir(sources, { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(path.join(sources, 'detail.png'));
}

async function sourceManifest() {
  const descriptions = [
    { file: 'Duck.glb', title: 'Duck', author: 'Sony Computer Entertainment', license: 'SCEA Shared Source License 1.0', licenseFile: 'sources/Duck-license.txt',
      source: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Duck/glTF-Binary/Duck.glb',
      attribution: 'https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/Duck/README.md',
      modifications: 'Original retained. Candidate derivatives use per-primitive simplification and opaque color-texture resizing/encoding as recorded in recipes.' },
    { file: 'Avocado.glb', title: 'Avocado', author: 'Microsoft', license: 'CC0-1.0',
      source: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Avocado/glTF-Binary/Avocado.glb',
      attribution: 'https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/Avocado/README.md',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode',
      modifications: 'Original retained. Candidate derivatives preserve original normal and metallic-roughness images and optimize opaque color plus geometry.' },
    { file: 'astronaut.png', title: 'Astronaut Eileen Collins', author: 'NASA', license: 'Public domain, United States government work',
      source: 'https://raw.githubusercontent.com/scikit-image/scikit-image/v0.25.2/skimage/data/astronaut.png',
      attribution: 'https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.astronaut',
      modifications: 'Original retained. Image candidates are resized and encoded at the explicitly recorded dimensions and formats.' },
    { file: 'detail.png', title: 'Field Notes detail sheet', author: 'AssetFit project contributors', license: 'CC0-1.0', source: 'scripts/examples.mjs#makeDetailSheet',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode',
      modifications: 'Purpose-built transparency and small-text constraint fixture; generated locally from vector shapes and text. Not used as sole real-asset evidence.' },
  ];
  for (const source of descriptions) {
    const bytes = await readFile(path.join(sources, source.file));
    source.sha256 = hash(bytes); source.bytes = bytes.length; source.snapshotVersion = `sha256:${source.sha256}`;
  }
  const manifest = { schemaVersion: 1, recordedAt: new Date().toISOString(), note: 'Each asset has its own license. Snapshot content hashes bind source versions even when upstream URLs refer to a moving branch.', assets: descriptions };
  await json(path.join(root, 'examples/SOURCES.json'), manifest);
  return manifest;
}

async function projectFor(name, files, usages, constraints = {}) {
  const pointer = path.join(artifacts, `${name}-latest.json`);
  let entry;
  if (process.argv.includes('--reuse')) try {
    const previous = JSON.parse(await readFile(pointer, 'utf8'));
    entry = { dir: path.join(root, previous.dir), project: await loadProject(path.join(root, previous.dir)) };
  } catch { /* A missing prior example starts a fresh measured run. */ }
  if (!entry) {
    entry = await createProject(path.join(artifacts, 'projects'), { name: `Field Notes / ${name}`, budgets: [{ name: 'initial', bytes: 20_000_000 }], settings: { maxEvaluations: 12, maxImageCandidates: 8, seed: 42, method: 'evolutionary', useSurrogate: true } });
    await importFiles(entry.dir, entry.project, files.map((file) => path.join(sources, file)));
    if (entry.project.importFailures.length) throw new Error(JSON.stringify(entry.project.importFailures));
    for (const asset of entry.project.assets) {
      if (usages[asset.name]) asset.usages = usages[asset.name];
      if (constraints[asset.name]) asset.constraints = { ...asset.constraints, ...constraints[asset.name] };
    }
    await persist(entry.dir, entry.project);
  }
  await optimize(entry.dir, entry.project, { onProgress: (event) => console.log(`${name}: ${event.message}`) });
  if (entry.project.assets.some((asset) => asset.status !== 'complete' || !asset.candidates.some((candidate) => candidate.valid))) throw new Error(`Example ${name} did not complete: ${JSON.stringify(entry.project.assets.map((asset) => ({ name: asset.name, status: asset.status, error: asset.error })))}`);
  await json(pointer, { dir: relative(entry.dir), projectId: entry.project.id });
  return entry;
}

function allByteBreakpoints(assets) {
  let sums = new Set([0]);
  for (const asset of assets) sums = new Set([...sums].flatMap((sum) => asset.candidates.filter((candidate) => candidate.valid).map((candidate) => sum + candidate.bytes)));
  return [...sums].sort((a, b) => a - b);
}

function chooseBudgets(project) {
  const points = allByteBreakpoints(project.assets);
  const table = [];
  let prior;
  for (const budget of points) {
    const result = allocate(project.assets, budget);
    if (!result.feasible || JSON.stringify(result.selected) === prior) continue;
    prior = JSON.stringify(result.selected);
    table.push({ budget, ...result });
  }
  if (!table.length) throw new Error('No measured mixed allocation is feasible.');
  const lowIndex = Math.floor((table.length - 1) * 0.2);
  const mediumIndex = Math.floor((table.length - 1) * 0.55);
  const highIndex = Math.floor((table.length - 1) * 0.85);
  const budgets = [{ name: 'lite', bytes: table[lowIndex].budget }, { name: 'standard', bytes: table[mediumIndex].budget }, { name: 'high', bytes: table[highIndex].budget }];
  const glb = project.assets.find((asset) => asset.type === 'glb');
  const image = project.assets.find((asset) => asset.name === 'astronaut.png');
  const priorityComparisons = table.map((entry) => {
    const favorModel = allocate(project.assets, entry.budget, { [glb.id]: 8 });
    const favorPhoto = allocate(project.assets, entry.budget, { [image.id]: 8 });
    return { budget: entry.budget, balanced: entry, favorModel, favorPhoto,
      changedBothTypes: favorModel.selected[glb.id] !== favorPhoto.selected[glb.id] && favorModel.selected[image.id] !== favorPhoto.selected[image.id] };
  });
  const priorityExample = priorityComparisons.find((entry) => entry.changedBothTypes) || null;
  return { budgets, table, priorityComparisons, priorityExample,
    selectionRule: 'Enumerate every distinct sum of measured candidate bytes. Retain allocation transitions at equal asset priorities; choose the 20%, 55%, and 85% transition indices as lite, standard, and high. Record every transition and all priority checks. For priority illustration, show the first ascending budget where priorities 8:1 and 1:8 change both the model and photograph.' };
}

async function checkFinalModels(entry) {
  const started = performance.now();
  const renderer = await createRenderer({ workDir: path.join(entry.dir, 'final-checks') });
  function makeRelative(value) {
    if (Array.isArray(value)) return value.map(makeRelative);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, makeRelative(child)]));
    return typeof value === 'string' && value.startsWith(entry.dir + path.sep) ? path.relative(entry.dir, value) : value;
  }
  try {
    for (const asset of entry.project.assets.filter((asset) => asset.type === 'glb')) {
      const context = await renderer.reference(path.join(entry.dir, asset.source), asset.usages);
      const selected = new Set(Object.values(entry.project.allocations).filter((allocation) => allocation.feasible).map((allocation) => allocation.selected[asset.id]));
      for (const id of selected) {
        const candidate = asset.candidates.find((candidate) => candidate.id === id);
        const finalCheck = await renderer.evaluate(path.join(entry.dir, candidate.file), context, { heldout: true });
        candidate.finalCheck = makeRelative({ ...finalCheck, selectionPolicy: 'Additional fixed cameras checked only after all example budgets were allocated. Scores did not select or rank candidates.' });
        if (finalCheck.valid === false) throw new Error(`Selected example candidate ${id} failed held-out validity checks.`);
      }
    }
  } finally { await renderer.close(); }
  const durationMs = performance.now() - started;
  entry.project.cost.finalCheckMs = (entry.project.cost.finalCheckMs || 0) + durationMs;
  entry.project.cost.glbMs += durationMs;
  entry.project.cost.elapsedMs += durationMs;
  await persist(entry.dir, entry.project);
}

async function publishLocalDemo(entry, evidence, provenance) {
  const { dir, project } = entry;
  // This directory contains only reproducible generated demonstration outputs.
  await rm(demoDir, { recursive: true, force: true });
  await mkdir(demoDir, { recursive: true });
  const copied = new Set();
  async function rewrite(value, key = '') {
    if (Array.isArray(value)) return Promise.all(value.map((item) => rewrite(item, key)));
    if (value && typeof value === 'object') {
      const result = {};
      for (const [childKey, child] of Object.entries(value)) {
        if (childKey === 'sourceKey') continue;
        result[childKey] = await rewrite(child, childKey);
      }
      return result;
    }
    if (typeof value === 'string') {
      const candidate = path.isAbsolute(value) ? value : path.resolve(dir, value);
      if (candidate.startsWith(dir + path.sep) && /\.(?:glb|png|webp|jpe?g)$/.test(candidate)) {
        try {
          if ((await stat(candidate)).isFile()) {
            const target = path.relative(dir, candidate);
            if (!copied.has(target)) { await mkdir(path.dirname(path.join(demoDir, target)), { recursive: true }); await copyFile(candidate, path.join(demoDir, target)); copied.add(target); }
            return target;
          }
        } catch { return value; }
      }
      if (path.isAbsolute(value)) return path.basename(value);
    }
    return value;
  }
  const demo = await rewrite(project);
  demo.precomputed = true;
  demo.demo = { title: 'Field Notes', description: 'A real mixed archive: a static GLB, a NASA portrait, and a lossless detail sheet.',
    candidateGeneration: 'Precomputed locally by the actual image encoders and GLB search pipeline. Budget and priority allocation are recomputed in your browser.',
    cameraPolicy: 'The displayed archive was evaluated at recorded fixed cameras. Changing evaluation cameras requires the local program.',
    selectionRule: evidence.selectionRule, priorityExample: evidence.priorityExample, downloads: {} };
  for (const budget of project.budgets) {
    const info = await exportDelivery(dir, project, budget.name);
    const archive = await JSZip.loadAsync(await readFile(path.join(dir, info.archive)));
    archive.file('SOURCE-LICENSES.json', JSON.stringify(provenance, null, 2));
    archive.file('licenses/Duck-license.txt', await readFile(path.join(sources, 'Duck-license.txt')));
    const archiveBytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    await mkdir(path.join(demoDir, 'downloads'), { recursive: true });
    const archiveFile = `downloads/${budget.name}.zip`;
    const reportFile = `downloads/${budget.name}-report.html`;
    await writeFile(path.join(demoDir, archiveFile), archiveBytes);
    await copyFile(path.join(dir, info.report), path.join(demoDir, reportFile));
    demo.demo.downloads[budget.name] = { archive: archiveFile, report: reportFile, assetBytes: info.assetBytes,
      zipBytes: archiveBytes.length, metadataBytes: info.metadataBytes, licenseBytes: Buffer.byteLength(JSON.stringify(provenance, null, 2)) + (await stat(path.join(sources, 'Duck-license.txt'))).size,
      verified: info.verified };
  }
  await json(path.join(demoDir, 'project.json'), demo);
  await json(path.join(demoDir, 'evidence.json'), evidence);
  await json(path.join(demoDir, 'SOURCES.json'), provenance);
  await copyFile(path.join(sources, 'Duck-license.txt'), path.join(demoDir, 'Duck-license.txt'));
  await writeFile(path.join(demoDir, 'README.txt'), `AssetFit measured demonstration archive\n\nThis folder contains real source-derived candidates, fixed-camera render comparisons, image usage comparisons, and verified delivery downloads. Candidate generation is precomputed. The static application recalculates allocation over this archive locally in the browser. It does not simulate processing your files.\n\nRun the application from the repository with pnpm install --frozen-lockfile, pnpm build, then pnpm start. Run pnpm build to prepare the static dist folder for a web server. Opening index.html directly with file:// is not supported because browser modules fetch local archive JSON. No permanent application backend is needed for the static demonstration.\n\nFor a fresh measured example run: pnpm examples. To verify and reuse a matching archive: pnpm examples --reuse. Own files are handled by the local application or CLI. No sources are automatically uploaded.\n\nSOURCES.json records each asset's provenance, license and exact SHA256. Duck-license.txt applies to the Duck source and its derivatives. Candidate modifications are documented in project.json and each downloadable recipe.\n\nAsset bytes count selected visual resource files. ZIP and metadata sizes are measured separately. Model/photograph quality scores are engineering differences in stated viewing conditions, not percentages of human visual quality.\n`);
  return { copiedFiles: copied.size, archive: relative(path.join(demoDir, 'project.json')), downloads: demo.demo.downloads };
}

await makeDetailSheet();
const provenance = await sourceManifest();
const usage = (width, height, regions = []) => [{ width, height, dpr: 1, fit: 'contain', weight: 1, regions }];
const mixed = await projectFor('mixed', ['Duck.glb', 'astronaut.png', 'detail.png'], {
  'Duck.glb': usage(256, 256), 'astronaut.png': usage(320, 320), 'detail.png': usage(640, 320),
}, { 'detail.png': { lossless: true, preserveDimensions: true, minWidth: 960, minHeight: 480, preserveAlpha: true, formats: ['png', 'webp'] } });
const budgetEvidence = chooseBudgets(mixed.project);
mixed.project.budgets = budgetEvidence.budgets;
await solve(mixed.dir, mixed.project);
await checkFinalModels(mixed);
const baselines = budgetEvidence.budgets.map((budget) => ({ budget, exact: allocate(mixed.project.assets, budget.bytes),
  greedy: allocateGreedy(mixed.project.assets, budget.bytes), proportional: allocateProportional(mixed.project.assets, budget.bytes) }));
const demo = await publishLocalDemo(mixed, { ...budgetEvidence, baselines }, provenance);

const imageOnly = await projectFor('images', ['astronaut.png', 'detail.png'], { 'astronaut.png': usage(320, 320), 'detail.png': usage(640, 320) },
  { 'detail.png': { lossless: true, preserveDimensions: true, formats: ['png', 'webp'] } });
imageOnly.project.budgets = [{ name: 'image-delivery', bytes: Math.max(1, Math.round(imageOnly.project.assets.reduce((sum, asset) => sum + asset.sourceBytes, 0) * 0.18)) }];
await solve(imageOnly.dir, imageOnly.project);
const imageExport = await exportDelivery(imageOnly.dir, imageOnly.project, 'image-delivery');

const modelOnly = await projectFor('models', ['Avocado.glb'], { 'Avocado.glb': usage(256, 256) });
const validModels = modelOnly.project.assets[0].candidates.filter((candidate) => candidate.valid).sort((a, b) => a.bytes - b.bytes);
modelOnly.project.budgets = [{ name: 'model-delivery', bytes: validModels[Math.floor(validModels.length / 2)].bytes }];
await solve(modelOnly.dir, modelOnly.project);
await checkFinalModels(modelOnly);
const modelExport = await exportDelivery(modelOnly.dir, modelOnly.project, 'model-delivery');

const summarize = (entry) => ({ projectId: entry.project.id, directory: relative(entry.dir), status: entry.project.status,
  sourceBytes: entry.project.assets.reduce((sum, asset) => sum + asset.sourceBytes, 0), assets: entry.project.assets.map((asset) => ({ name: asset.name, type: asset.type,
    candidateCount: asset.candidates.length, validCandidates: asset.candidates.filter((candidate) => candidate.valid).length,
    candidates: asset.candidates.map((candidate) => ({ id: candidate.id, valid: candidate.valid, bytes: candidate.bytes, loss: candidate.metrics?.loss, hash: candidate.hash })) })),
  allocations: entry.project.allocations, cost: entry.project.cost });
const report = { generatedAt: new Date().toISOString(), allData: 'Actual measured local runs; no predicted quality scores used as candidate measurements.',
  projects: { mixed: summarize(mixed), images: summarize(imageOnly), models: summarize(modelOnly) }, demo,
  mixedReallocation: { changedAcrossBudgets: new Set(Object.values(mixed.project.allocations).map((allocation) => JSON.stringify(allocation.selected))).size > 1,
    changedBothTypesWithPriority: Boolean(budgetEvidence.priorityExample), priorityExample: budgetEvidence.priorityExample },
  independentDeliveries: [imageExport, modelExport].map(({ budgetName, assetBytes, metadataBytes, zipBytes, verified }) => ({ budgetName, assetBytes, metadataBytes, zipBytes, verified })) };
await json(path.join(artifacts, 'verification.json'), report);
console.log(JSON.stringify({ mixed: report.projects.mixed.allocations, reallocation: report.mixedReallocation, demo, imageExport: imageExport.verified, modelExport: modelExport.verified }, null, 2));
