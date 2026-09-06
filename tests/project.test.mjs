import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, copyFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import JSZip from 'jszip';
import { createProject, importFiles, configure, optimize, solve, loadProject, makeRecipe, makePolicy, replay, replaceCandidate } from '../src/project.mjs';
import { exportDelivery, verifyDelivery } from '../src/delivery.mjs';
import { inside, fileHash } from '../src/util.mjs';

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'assetfit-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'sample.png');
  const raw = Buffer.alloc(96 * 64 * 3);
  for (let p = 0; p < raw.length; p++) raw[p] = (p * 29 + Math.floor(p / 39) * 19) % 256;
  await sharp(raw, { raw: { width: 96, height: 64, channels: 3 } }).png().toFile(source);
  const created = await createProject(path.join(root, 'projects'), { name: 'Image delivery', budgets: [{ name: 'standard', bytes: 1_000_000 }], settings: { imageCandidates: 5 }, ...options });
  await importFiles(created.dir, created.project, [source]);
  await configure(created.dir, created.project, { assets: [{ id: created.project.assets[0].id, usages: [{ width: 96, height: 64, dpr: 1, fit: 'contain', weight: 1, regions: [] }] }] });
  return { root, source, ...created };
}

test('physical references merge but distinct copied paths remain independently charged', async (t) => {
  const { root, source, dir, project } = await setup(t);
  const duplicate = path.join(root, 'second-copy.png');
  await copyFile(source, duplicate);
  await importFiles(dir, project, [source, duplicate]);
  assert.equal(project.assets.length, 2);
  assert.equal(project.assets[0].usages.length, 2);
  assert.equal(project.assets[0].sourceHash, project.assets[1].sourceHash);
  await optimize(dir, project);
  const allocation = project.allocations.standard;
  const selected = project.assets.map((asset) => asset.candidates.find((candidate) => candidate.id === allocation.selected[asset.id]));
  assert.equal(allocation.bytes, selected.reduce((sum, candidate) => sum + candidate.bytes, 0));
  assert.equal(Object.keys(allocation.selected).length, 2);
});

test('real export verifies actual visual bytes, hashes, independent image decode and separate ZIP size', async (t) => {
  const { dir, project } = await setup(t);
  await optimize(dir, project);
  const info = await exportDelivery(dir, project, 'standard');
  const out = path.join(dir, 'exports', info.exportId);
  const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal((await verifyDelivery(out)).valid, true);
  assert.equal(info.assetBytes, project.allocations.standard.bytes);
  assert.equal(info.assetBytes, manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0));
  assert.equal(info.zipBytes, (await stat(path.join(out, 'delivery.zip'))).size);
  const zip = await JSZip.loadAsync(await readFile(path.join(out, 'delivery.zip')));
  for (const asset of manifest.assets) {
    const extracted = await zip.file(asset.file).async('nodebuffer');
    assert.equal(extracted.length, asset.bytes);
    assert.equal((await sharp(extracted).raw().toBuffer()).length > 0, true);
  }
  assert.ok(info.metadataBytes > 0);
  assert.ok(project.cost.imageMs > 0);
  assert.ok(project.cost.elapsedMs >= project.cost.imageMs);
});

test('actual minimum candidate bytes give an exact one-byte feasibility boundary', async (t) => {
  const { dir, project } = await setup(t);
  await optimize(dir, project);
  const minimum = project.assets.reduce((sum, asset) => sum + Math.min(...asset.candidates.filter((candidate) => candidate.valid).map((candidate) => candidate.bytes)), 0);
  await configure(dir, project, { budgets: [{ name: 'fits', bytes: minimum }, { name: 'short', bytes: minimum - 1 }] });
  await solve(dir, project);
  assert.equal(project.allocations.fits.feasible, true);
  assert.equal(project.allocations.fits.bytes, minimum);
  assert.equal(project.allocations.short.feasible, false);
  await assert.rejects(exportDelivery(dir, project, 'short'), /No feasible/);
  assert.equal((await exportDelivery(dir, project, 'fits')).assetBytes, minimum);
});

test('cancellation persists completed candidate and resumes from verified measurements', async (t) => {
  const { dir, project } = await setup(t);
  const controller = new AbortController();
  await optimize(dir, project, { signal: controller.signal, onProgress: () => controller.abort() });
  assert.equal(project.status, 'cancelled');
  assert.equal(project.assets[0].candidates.length, 1);
  const previousCost = project.cost.elapsedMs;
  const savedHash = project.assets[0].candidates[0].hash;
  const restored = await loadProject(dir);
  assert.equal(restored.status, 'cancelled');
  await optimize(dir, restored);
  assert.equal(restored.status, 'complete');
  assert.equal(restored.assets[0].candidates[0].hash, savedHash);
  assert.ok(restored.assets[0].observations.some((observation) => observation.phase === 'cache-hit'));
  assert.ok(restored.cost.elapsedMs > previousCost);
  assert.equal(restored.allocations.standard.feasible, true);
});

test('budget and asset priority reuse archive; usage changes block stale export until reevaluation', async (t) => {
  const { dir, project } = await setup(t);
  await optimize(dir, project);
  const initialKey = project.assets[0].epoch;
  const measurements = project.observations.length;
  const imageMs = project.cost.imageMs;
  await configure(dir, project, { assets: [{ id: project.assets[0].id, priority: 3 }] });
  await solve(dir, project);
  assert.equal(project.assets[0].epoch, initialKey);
  assert.equal(project.observations.length, measurements);
  assert.equal(project.cost.imageMs, imageMs);
  await configure(dir, project, { assets: [{ id: project.assets[0].id, usages: [{ width: 48, height: 32, dpr: 1, fit: 'contain', weight: 1, regions: [] }] }] });
  await assert.rejects(solve(dir, project), /changed/);
  await optimize(dir, project);
  assert.notEqual(project.assets[0].epoch, initialKey);
  assert.ok(project.observations.length > measurements);
  assert.equal(project.assets[0].candidates[0].metrics.uses[0].width, 48);
});

test('source-bound recipe replays matching inputs while policy has no old asset mapping', async (t) => {
  const { root, source, dir, project } = await setup(t);
  await optimize(dir, project);
  const recipe = makeRecipe(project);
  const policy = makePolicy(project);
  assert.equal(recipe.kind, 'recipe');
  assert.equal(policy.kind, 'policy');
  assert.equal(Object.hasOwn(policy, 'assets'), false);
  const replayed = await replay(path.join(root, 'replays'), recipe, [source]);
  assert.equal(replayed.project.replay.consistent, true);
  assert.ok(replayed.project.replay.checks.every((check) => check.match));
  const changed = path.join(root, 'changed.png');
  await sharp(source).resize(12, 8).png().toFile(changed);
  await assert.rejects(replay(path.join(root, 'replays'), recipe, [changed]), /mismatch/);
});

test('one rejected input leaves supported assets usable and imported sources untouched', async (t) => {
  const { root, source, dir, project } = await setup(t);
  const originalHash = await fileHash(source);
  const bad = path.join(root, 'broken.png');
  await writeFile(bad, 'not an image');
  const imported = await importFiles(dir, project, [bad]);
  assert.equal(imported.failures.length, 1);
  assert.equal(project.assets.length, 1);
  await optimize(dir, project);
  assert.equal(project.allocations.standard.feasible, true);
  assert.equal(await fileHash(source), originalHash);
});

test('export stops if a selected physical candidate changes', async (t) => {
  const { dir, project } = await setup(t);
  await optimize(dir, project);
  const asset = project.assets[0];
  const selected = asset.candidates.find((candidate) => candidate.id === project.allocations.standard.selected[asset.id]);
  await writeFile(inside(dir, selected.file), 'tampered output');
  await assert.rejects(exportDelivery(dir, project, 'standard'), /changed on disk/);
});

test('failed physical processing is not reported as complete and successful recovery clears the error', async (t) => {
  const { dir, project, root, source } = await setup(t);
  const asset = project.assets[0];
  await configure(dir, project, { assets: [{ id: asset.id, constraints: { lockOriginal: true } }] });
  await optimize(dir, project);
  const managed = project.assets[0];
  const file = inside(dir, managed.candidates[0].file);
  const original = await readFile(file);
  await writeFile(file, 'damaged historical candidate');
  await optimize(dir, project);
  assert.equal(project.status, 'failed');
  assert.equal(managed.status, 'failed');
  assert.match(managed.error, /content hash|historical bytes/);
  assert.equal(managed.constraints.lockOriginal, true);
  assert.equal(project.allocations.standard.feasible, false);
  await assert.rejects(exportDelivery(dir, project, 'standard'), /No feasible/);

  const secondSource = path.join(root, 'second.png');
  await copyFile(source, secondSource);
  await importFiles(dir, project, [secondSource]);
  await optimize(dir, project);
  assert.equal(project.status, 'partial');
  assert.equal(project.assets[0].status, 'failed');
  assert.equal(project.assets[1].status, 'complete');
  assert.equal(project.allocations.standard.feasible, false, 'An asset failure cannot drop that asset from the shared budget problem.');

  await writeFile(file, original);
  await optimize(dir, project);
  assert.equal(project.status, 'complete');
  assert.equal(managed.status, 'complete');
  assert.equal(managed.error, null);
  assert.equal(project.error, null);
  assert.equal(managed.candidates[0].hash, managed.sourceHash);
  assert.equal(project.allocations.standard.feasible, true);
});

test('reports escape hostile asset names and omit private absolute source paths', async (t) => {
  const { source, dir, project } = await setup(t, { name: '<script>alert(1)</script>' });
  project.assets[0].name = '<img src=x onerror=alert(1)>.png';
  await optimize(dir, project);
  const info = await exportDelivery(dir, project, 'standard');
  const out = path.join(dir, 'exports', info.exportId);
  const html = await readFile(path.join(out, 'report.html'), 'utf8');
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
  for (const name of ['report.html', 'report.json', 'manifest.json', 'recipe.json', 'policy.json']) assert.equal((await readFile(path.join(out, name), 'utf8')).includes(source), false);
});

test('managed path traversal is rejected', () => {
  assert.throws(() => inside('/tmp/project', '../secret'), /outside/);
  assert.throws(() => inside('/tmp/project', '/etc/passwd'), /outside/);
  assert.equal(inside('/tmp/project', 'assets/a.png'), '/tmp/project/assets/a.png');
});

test('delivery verification rejects undecodable image bytes even with consistent manifest hashes', async (t) => {
  const { dir, project } = await setup(t);
  await optimize(dir, project);
  const info = await exportDelivery(dir, project, 'standard');
  const out = path.join(dir, 'exports', info.exportId);
  const manifestPath = path.join(out, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const asset = manifest.assets[0];
  const file = inside(out, asset.file);
  await writeFile(file, 'not an independently openable image');
  asset.bytes = (await stat(file)).size;
  asset.sha256 = await fileHash(file);
  manifest.assetBytes = asset.bytes;
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal((await verifyDelivery(out)).valid, false);
});

test('recipe cannot introduce path traversal via its asset mapping', async (t) => {
  const { root, source, dir, project } = await setup(t);
  await optimize(dir, project);
  const recipe = makeRecipe(project);
  recipe.assets[0].id = '../../escape';
  await assert.rejects(replay(path.join(root, 'replays'), recipe, [source]), /ID|mapping|invalid/i);
});

test('source tampering is detected before verified candidate cache reuse', async (t) => {
  const { dir, project } = await setup(t);
  await optimize(dir, project);
  await writeFile(inside(dir, project.assets[0].source), 'changed managed source');
  await assert.rejects(optimize(dir, project), /source|hash|changed/i);
});

test('distinct uploaded files with identical names and contents stay independently charged', async (t) => {
  const { root, source } = await setup(t);
  const copy = path.join(root, 'copied.png');
  await copyFile(source, copy);
  const { dir, project } = await createProject(path.join(root, 'uploads'));
  await importFiles(dir, project, [source, copy], { names: ['logo.png', 'logo.png'] });
  assert.equal(project.assets.length, 2);
  assert.notEqual(project.assets[0].id, project.assets[1].id);
});

test('rejected configuration patch leaves persisted and in-memory project unchanged', async (t) => {
  const { dir, project } = await setup(t);
  await optimize(dir, project);
  const before = JSON.stringify(project);
  await assert.rejects(configure(dir, project, { name: 'Partial update', assets: [{ id: project.assets[0].id, priority: 4 }, { id: 'missing-asset', priority: 1 }] }), /not found/);
  assert.equal(JSON.stringify(project), before);
  assert.deepEqual(await loadProject(dir), JSON.parse(before));
});

test('initial project settings reject duplicate budgets and invalid evaluation limits', async (t) => {
  const { root } = await setup(t);
  await assert.rejects(createProject(path.join(root, 'invalid'), { budgets: [{ name: 'a', bytes: 1 }, { name: 'a', bytes: 2 }] }), /unique|duplicate/i);
  await assert.rejects(createProject(path.join(root, 'invalid'), { budgets: [] }), /budget|1.*8/i);
  await assert.rejects(createProject(path.join(root, 'invalid'), { settings: { maxEvaluations: 0 } }), /evaluation|measurement|1.*64/i);
  await assert.rejects(createProject(path.join(root, 'invalid'), { budgets: [{ name: '__proto__', bytes: 1 }] }), /reserved|name|invalid/i);
});

test('delivery verification rejects an unknown visual asset type', async (t) => {
  const { dir, project } = await setup(t);
  await optimize(dir, project);
  const info = await exportDelivery(dir, project, 'standard');
  const out = path.join(dir, 'exports', info.exportId);
  const manifestPath = path.join(out, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.assets[0].type = 'unknown';
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal((await verifyDelivery(out)).valid, false);
});

test('manual measured choice survives export, persisted project and source-bound replay', async (t) => {
  const { root, source, dir, project } = await setup(t);
  await optimize(dir, project);
  const asset = project.assets[0];
  const automatic = asset.candidates.find((candidate) => candidate.id === project.allocations.standard.selected[asset.id]);
  const manual = asset.candidates.find((candidate) => candidate.valid && candidate.metrics.loss > automatic.metrics.loss);
  assert.ok(manual, 'Fixture must provide a genuinely lower-quality alternative.');
  await replaceCandidate(dir, project, 'standard', asset.id, manual.id);
  assert.equal(project.allocations.standard.exact, false);
  assert.equal(project.allocations.standard.method, 'user-selected-alternative');
  assert.equal(project.allocations.standard.selected[asset.id], manual.id);
  assert.equal(makeRecipe(project).manualChoices.standard[asset.id], manual.hash);

  const info = await exportDelivery(dir, project, 'standard');
  const out = path.join(dir, 'exports', info.exportId);
  const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
  const recipe = JSON.parse(await readFile(path.join(out, 'recipe.json'), 'utf8'));
  const report = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8'));
  assert.equal(manifest.assets[0].sha256, manual.hash);
  assert.equal(manifest.assetBytes, manual.bytes);
  assert.equal(recipe.manualChoices.standard[asset.id], manual.hash);
  assert.equal(report.allocation.exact, false);
  assert.match(report.scope, /User-replaced/);
  const persisted = await loadProject(dir);
  assert.equal(persisted.allocations.standard.selected[asset.id], manual.id);
  assert.equal(persisted.allocations.standard.exact, false);
  assert.equal(persisted.exports.filter((entry) => entry.exportId === info.exportId).length, 1);

  const replayed = await replay(path.join(root, 'manual-replay'), recipe, [source]);
  assert.equal(replayed.project.replay.consistent, true);
  assert.equal(replayed.project.allocations.standard.exact, false);
  assert.equal(replayed.project.allocations.standard.method, 'user-selected-alternative');
  const replayedAsset = replayed.project.assets[0];
  const replayedChoice = replayedAsset.candidates.find((candidate) => candidate.id === replayed.project.allocations.standard.selected[asset.id]);
  assert.equal(replayedChoice.hash, manual.hash);
  assert.ok(replayedChoice.metrics.loss > automatic.metrics.loss);
  const replayedInfo = await exportDelivery(replayed.dir, replayed.project, 'standard');
  assert.equal(replayedInfo.files[0].sha256, manual.hash);
  assert.equal((await loadProject(replayed.dir)).allocations.standard.exact, false);
});
