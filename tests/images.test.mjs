import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { generateImageCandidates, inspectImage, evaluateImage, normalizeImageUsages } from '../src/images.mjs';

async function fixture(t, alpha = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'assetfit-images-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const width = 96;
  const height = 64;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    raw[offset] = x * 2;
    raw[offset + 1] = y * 3;
    raw[offset + 2] = (x + y) % 4 < 2 ? 255 : 0;
    raw[offset + 3] = alpha ? (x < 20 ? 0 : x < 30 ? 125 : 255) : 255;
  }
  const sourcePath = path.join(dir, 'source.png');
  let encoder = sharp(raw, { raw: { width, height, channels: 4 } });
  if (!alpha) encoder = encoder.removeAlpha();
  await encoder.png().toFile(sourcePath);
  return { dir, sourcePath, raw, width, height };
}

test('image candidates are real encoded files, measured from disk and evaluated at usage size', async (t) => {
  const { dir, sourcePath } = await fixture(t);
  const events = [];
  const candidates = await generateImageCandidates({ sourcePath, outputDir: path.join(dir, 'out'), asset: { usages: [{ width: 48, height: 32, dpr: 2, fit: 'contain' }] }, onObservation: (event) => events.push(event) });
  assert.ok(candidates.length >= 5);
  assert.ok(new Set(candidates.filter((candidate) => candidate.valid).map((candidate) => candidate.bytes)).size >= 3);
  assert.ok(candidates.some((candidate) => candidate.metrics.loss > 0));
  for (const candidate of candidates) {
    assert.equal((await stat(candidate.file)).size, candidate.bytes);
    assert.equal((await inspectImage(candidate.file)).hash, candidate.hash);
    assert.equal(candidate.metrics.uses[0].width, 96);
    assert.equal(candidate.metrics.uses[0].height, 64);
    assert.ok(Number.isFinite(candidate.metrics.loss));
    assert.ok(candidate.costMs > 0);
    for (const preview of [candidate.metrics.reference, candidate.metrics.preview, candidate.metrics.difference]) {
      const raster = await sharp(preview).metadata();
      assert.equal(raster.width, 96);
      assert.equal(raster.height, 64);
    }
  }
  assert.ok((await readFile(candidates.find((candidate) => candidate.id === 'original').file)).equals(await readFile(sourcePath)));
  assert.equal(candidates.find((candidate) => candidate.id === 'original').metrics.loss, 0);
  assert.equal(events.filter((event) => ['evaluated', 'invalid'].includes(event.phase)).length, candidates.length);
});

test('transparent image never becomes JPEG and lossless constraint verifies decoded equality', async (t) => {
  const { dir, sourcePath } = await fixture(t, true);
  const candidates = await generateImageCandidates({ sourcePath, outputDir: path.join(dir, 'out'), asset: { usages: [{ width: 48, height: 32 }], constraints: { lossless: true } } });
  assert.ok(candidates.filter((candidate) => candidate.valid).length >= 2);
  for (const candidate of candidates.filter((candidate) => candidate.valid)) {
    assert.notEqual(candidate.params.format, 'jpeg');
    assert.equal(candidate.metadata.hasAlpha, true);
    assert.equal(candidate.metadata.width, 96);
    assert.equal(candidate.metrics.uses[0].width, 48);
    assert.equal(candidate.metrics.loss, 0);
  }
  const incompatible = await generateImageCandidates({ sourcePath, outputDir: path.join(dir, 'jpeg'), asset: { constraints: { formats: ['jpeg'] } } });
  assert.ok(incompatible.length > 0);
  assert.ok(incompatible.every((candidate) => !candidate.valid));
});

test('original lock preserves exact JPEG bytes, EXIF orientation and compatibility still apply', async (t) => {
  const { dir, sourcePath } = await fixture(t);
  const jpeg = path.join(dir, 'oriented.jpg');
  await sharp(sourcePath).jpeg({ quality: 91 }).withMetadata({ orientation: 6 }).toFile(jpeg);
  const metadata = await inspectImage(jpeg);
  assert.equal(metadata.width, 64);
  assert.equal(metadata.height, 96);
  const locked = await generateImageCandidates({ sourcePath: jpeg, outputDir: path.join(dir, 'locked'), asset: { constraints: { lockOriginal: true } } });
  assert.equal(locked.length, 1);
  assert.equal(locked[0].valid, true);
  assert.ok((await readFile(locked[0].file)).equals(await readFile(jpeg)));
  const mismatch = await generateImageCandidates({ sourcePath: jpeg, outputDir: path.join(dir, 'wrong-format'), asset: { constraints: { lockOriginal: true, formats: ['png'] } } });
  assert.equal(mismatch[0].valid, false);
  const converted = await generateImageCandidates({ sourcePath: jpeg, outputDir: path.join(dir, 'converted'), asset: { constraints: { preserveDimensions: true, formats: ['png'] } } });
  const png = converted.find((candidate) => candidate.valid);
  assert.equal(png.metadata.width, 64);
  assert.equal(png.metadata.height, 96);
  assert.equal(png.metrics.loss, 0);
});

test('atlas constraints retain dimensions and minimums cannot be silently relaxed', async (t) => {
  const { dir, sourcePath } = await fixture(t);
  const fixed = await generateImageCandidates({ sourcePath, outputDir: path.join(dir, 'fixed'), asset: { constraints: { preserveDimensions: true } } });
  assert.ok(fixed.filter((candidate) => candidate.valid).every((candidate) => candidate.metadata.width === 96 && candidate.metadata.height === 64));
  const impossible = await generateImageCandidates({ sourcePath, outputDir: path.join(dir, 'minimum'), asset: { constraints: { minWidth: 200 } } });
  assert.ok(impossible.every((candidate) => !candidate.valid));
});

test('usage changes invalidate cache keys and complete resumed candidates verify actual hashes', async (t) => {
  const { dir, sourcePath } = await fixture(t);
  const asset = { usages: [{ width: 48, height: 32 }] };
  const first = await generateImageCandidates({ sourcePath, outputDir: path.join(dir, 'out'), asset, settings: { maxCandidates: 3 } });
  const resumed = await generateImageCandidates({ sourcePath, outputDir: path.join(dir, 'out'), asset, settings: { maxCandidates: 3, resumeCandidates: first } });
  assert.equal(resumed.costs.cacheHits, first.length);
  assert.equal(resumed.costs.proposals, 0);
  const changed = await generateImageCandidates({ sourcePath, outputDir: path.join(dir, 'out'), asset: { usages: [{ width: 96, height: 64 }] }, settings: { maxCandidates: 3, resumeCandidates: first } });
  assert.equal(changed.costs.cacheHits, 0);
  assert.notEqual(changed[0].cacheKey, first[0].cacheKey);
  await writeFile(first[1].file, 'corrupted cached file');
  const corrupted = await generateImageCandidates({ sourcePath, outputDir: path.join(dir, 'out'), asset, settings: { maxCandidates: 3, resumeCandidates: first } });
  assert.ok(corrupted.observations.some((event) => event.phase === 'cache-mismatch'));
  assert.ok(corrupted.observations.some((event) => event.phase === 'failed' && event.diagnostics[0].includes('refusing to overwrite')));
});

test('identity and multiple usage aggregation use actual display conditions', async (t) => {
  const { dir, sourcePath } = await fixture(t);
  const damaged = path.join(dir, 'damaged.jpg');
  await sharp(sourcePath).resize(12, 8).jpeg({ quality: 10 }).toFile(damaged);
  const usages = [{ width: 96, height: 64, weight: 3 }, { width: 12, height: 8, weight: 1 }];
  const metrics = await evaluateImage(sourcePath, damaged, usages);
  assert.equal(metrics.loss, (metrics.uses[0].loss * 3 + metrics.uses[1].loss) / 4);
  assert.ok(metrics.uses[0].loss > metrics.uses[1].loss);
  assert.equal((await evaluateImage(sourcePath, sourcePath, usages)).loss, 0);
});

test('usage validation and cooperative cancellation fail clearly', async (t) => {
  const { dir, sourcePath } = await fixture(t);
  assert.throws(() => normalizeImageUsages([{ width: 4000, height: 4000 }]), /exceeds/);
  assert.throws(() => normalizeImageUsages([{ regions: [{ x: 0.9, y: 0, width: 0.5, height: 1 }] }]), /outside/);
  assert.throws(() => normalizeImageUsages([{ dpr: 0 }]), /positive/);
  const controller = new AbortController();
  let completed = 0;
  await assert.rejects(generateImageCandidates({ sourcePath, outputDir: path.join(dir, 'out'), signal: controller.signal, onCandidate: () => { completed++; controller.abort(); } }), { name: 'AbortError' });
  assert.equal(completed, 1);
});

test('animated and unsupported source formats are rejected without timeline loss', async (t) => {
  const { dir } = await fixture(t);
  const gif = path.join(dir, 'tiny.gif');
  await writeFile(gif, Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  assert.equal((await inspectImage(gif)).supported, false);
  await assert.rejects(generateImageCandidates({ sourcePath: gif, outputDir: path.join(dir, 'out') }), /Only static/);
});
