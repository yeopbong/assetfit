import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createProject, importFiles, loadProject, optimize } from '../src/project.mjs';
import { inspectGlb, resolveGlbProtection } from '../src/glb.mjs';
import { exportDelivery, verifyDelivery } from '../src/delivery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('actual GLB project cancellation persists observations and resumes without resetting the allowance', {
  skip: process.env.ASSETFIT_RENDER_TESTS !== '1', timeout: 180_000,
}, async () => {
  const source = path.join(root, 'examples/sources/Duck.glb');
  const { dir, project } = await createProject(path.relative(process.cwd(), path.join(root, '.cache/project-glb-test')), {
    name: 'GLB cancellation regression', budgets: [{ name: 'standard', bytes: 100_000 }],
    settings: { maxEvaluations: 4, seed: 11, useSurrogate: false },
  });
  assert(path.isAbsolute(dir), 'Relative CLI output roots must normalize before candidate paths are stored.');
  const imported = await importFiles(dir, project, [source]);
  assert.deepEqual(imported.failures, []);
  const signal = new AbortController();
  await optimize(path.relative(process.cwd(), dir), project, { signal: signal.signal, onProgress: () => {
    if (project.assets[0].candidates.length === 2) signal.abort();
  } });
  assert.equal(project.status, 'cancelled');
  const interrupted = await loadProject(dir);
  assert.equal(interrupted.assets[0].candidates.length, 2);
  assert(interrupted.assets[0].observations.some(event => event.event === 'candidate'));
  const originalHashes = interrupted.assets[0].candidates.map(candidate => candidate.hash);
  const spentBefore = interrupted.cost.elapsedMs;
  assert(spentBefore > 0);
  await optimize(dir, interrupted);
  const resumed = await loadProject(dir);
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.assets[0].candidates.length, 4);
  assert.deepEqual(resumed.assets[0].candidates.slice(0, 2).map(candidate => candidate.hash), originalHashes);
  const observations = resumed.assets[0].observations;
  assert.equal(observations.filter(event => event.event === 'candidate').length, 4);
  assert.equal(observations.filter(event => event.event === 'proposal').length, 4);
  assert.equal(observations.filter(event => event.event === 'candidate-retry').length, 0);
  assert.equal(observations.filter(event => event.event === 'resume-cache-hit').length, 2);
  assert(resumed.cost.elapsedMs > spentBefore);
  assert.equal(resumed.cost.retries, 1);
  for (const candidate of resumed.assets[0].candidates) {
    assert(candidate.valid);
    assert(!path.isAbsolute(candidate.file));
    const bytes = await readFile(path.join(dir, candidate.file));
    assert.equal(candidate.bytes, bytes.length);
    assert.equal(candidate.hash, createHash('sha256').update(bytes).digest('hex'));
  }
  assert(resumed.allocations.standard.feasible);
  assert(resumed.allocations.standard.bytes <= 100_000);
  const selectedId = resumed.allocations.standard.selected[resumed.assets[0].id];
  const selected = resumed.assets[0].candidates.find(candidate => candidate.id === selectedId);
  assert.equal(selected.finalCheck.stage, 'heldout');
  assert.equal(selected.metrics.stage, 'search');
  const capabilities = await inspectGlb(source);
  const parent = capabilities.objects.find(object => object.children.length && !object.meshId);
  const protection = resolveGlbProtection(capabilities, { lockedObjects: [parent.id] });
  assert.equal(protection.lockedGeometry.length, capabilities.geometryGroups.length);
  assert.equal(protection.lockedTextures.length, capabilities.textureGroups.length);
  assert(protection.requestedObjects.length > 1, 'A parent lock includes its descendants.');
  const movedDir = `${dir}-moved`;
  await rename(dir, movedDir);
  const relocated = await loadProject(movedDir);
  assert.equal(JSON.stringify(relocated).includes(dir), false, 'Managed references must remain portable after moving a project.');
  const delivery = await exportDelivery(path.relative(process.cwd(), movedDir), relocated, 'standard');
  assert.equal((await verifyDelivery(path.join(movedDir, 'exports', delivery.exportId))).valid, true);
  assert.equal(delivery.assetBytes, resumed.allocations.standard.bytes);
});
