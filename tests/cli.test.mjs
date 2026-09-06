import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createProject, importFiles, configure, optimize, loadProject } from '../src/project.mjs';
import { inside } from '../src/util.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function command(t, args, cancelAfterMeasurement = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', cancelled = false, closed = false;
    t.after(() => { if (!closed) child.kill('SIGKILL'); });
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => {
      stderr += data;
      if (cancelAfterMeasurement && !cancelled && stderr.includes('Measured ')) { cancelled = true; child.kill('SIGINT'); }
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      closed = true;
      try { resolve({ code, signal, result: JSON.parse(stdout), stderr, cancelled }); }
      catch (error) { reject(new Error(`CLI did not return JSON: ${stderr}`, { cause: error })); }
    });
  });
}

async function fixture(t, name) {
  const root = await mkdtemp(path.join(tmpdir(), 'assetfit-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'sample.png');
  const pixels = Buffer.alloc(512 * 512 * 3);
  for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 29 + Math.floor(index / 39) * 19) % 256;
  await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } }).png().toFile(source);
  const created = await createProject(path.join(root, 'projects with spaces'), { name, budgets: [{ name: 'standard', bytes: 1_000_000 }] });
  await importFiles(created.dir, created.project, [source]);
  return { root, source, ...created };
}

test('CLI resume reports failed and partial processing as exit 2 without confusing candidate-table infeasibility', { timeout: 30_000 }, async t => {
  const { root, source, dir, project } = await fixture(t, 'CLI failure status');
  await configure(dir, project, { assets: [{ id: project.assets[0].id, constraints: { lockOriginal: true } }] });
  await optimize(dir, project);
  const candidateFile = inside(dir, project.assets[0].candidates[0].file);
  const original = await readFile(candidateFile);
  await writeFile(candidateFile, 'damaged locked candidate');
  const failed = await command(t, ['resume', dir]);
  assert.equal(failed.code, 2);
  assert.equal(failed.result.status, 'failed');
  assert.equal(failed.result.allocations.standard.feasible, false);

  const saved = await loadProject(dir);
  const second = path.join(root, 'second.png');
  await copyFile(source, second);
  await importFiles(dir, saved, [second]);
  const partial = await command(t, ['resume', dir]);
  assert.equal(partial.code, 2);
  assert.equal(partial.result.status, 'partial');
  assert.equal(partial.result.allocations.standard.feasible, false);

  await writeFile(candidateFile, original);
  const recovered = await loadProject(dir);
  await configure(dir, recovered, { budgets: [{ name: 'standard', bytes: 1 }] });
  const constrained = await command(t, ['resume', dir]);
  assert.equal(constrained.code, 0, 'Completed measurements with a too-small budget are a result, not a processing error.');
  assert.equal(constrained.result.status, 'complete');
  assert.equal(constrained.result.allocations.standard.feasible, false);
  assert.match(constrained.result.allocations.standard.scope, /not a proof over ungenerated outputs/);
  assert.equal((await loadProject(dir)).assets[0].constraints.lockOriginal, true);
});

test('CLI SIGINT returns cancelled JSON and exit 130 after preserving a real measured candidate', { timeout: 30_000 }, async t => {
  const { dir } = await fixture(t, 'CLI cancellation status');
  const cancelled = await command(t, ['resume', dir], true);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.signal, null, 'The application must finish cooperative cancellation itself.');
  assert.equal(cancelled.code, 130);
  assert.equal(cancelled.result.status, 'cancelled');
  const saved = await loadProject(dir);
  assert.equal(saved.status, 'cancelled');
  assert(saved.assets[0].candidates.some(candidate => candidate.valid));
});
