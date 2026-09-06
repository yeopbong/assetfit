import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { compareRgba, differenceRgba } from '../src/metrics.mjs';

function fixture() {
  const width = 64, height = 64, source = Buffer.alloc(width * height * 4);
  for (let y = 8; y < 56; y++) for (let x = 8; x < 56; x++) {
    if (x > 47 && y < 30) continue;
    source.set([(Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 230 : 40, 120, 90, 255], (y * width + x) * 4);
  }
  for (let y = 2; y < 8; y++) for (let x = 28; x < 32; x++) source.set([230, 120, 90, 255], (y * width + x) * 4);
  return { width, height, source };
}

test('RGBA identity and invisible RGB produce exact zero', () => {
  const { width, height, source } = fixture();
  const hidden = Buffer.from(source);
  for (let i = 0; i < hidden.length; i += 4) if (hidden[i + 3] === 0) hidden[i] = 255;
  assert.equal(compareRgba(source, source, { width, height }).loss, 0);
  assert.equal(compareRgba(source, hidden, { width, height }).loss, 0);
});

test('actual blur, silhouette loss, small-part removal and alpha damage are detected', async () => {
  const { width, height, source } = fixture();
  const blur = await sharp(source, { raw: { width, height, channels: 4 } }).blur(2).raw().toBuffer();
  const silhouette = Buffer.from(source);
  for (let y = 8; y < 56; y++) for (let x = 8; x < 20; x++) silhouette[(y * width + x) * 4 + 3] = 0;
  const part = Buffer.from(source);
  for (let y = 2; y < 8; y++) for (let x = 28; x < 32; x++) part[(y * width + x) * 4 + 3] = 0;
  const transparency = Buffer.from(source);
  for (let i = 3; i < transparency.length; i += 4) transparency[i] = Math.floor(transparency[i] / 2);
  for (const damage of [blur, silhouette, part, transparency]) assert(compareRgba(source, damage, { width, height }).loss > 0);
  const globalPartLoss = compareRgba(source, part, { width, height });
  const localPartLoss = compareRgba(source, part, { width, height,
    regions: [{ x: 28 / 64, y: 2 / 64, width: 4 / 64, height: 6 / 64, weight: 10 }] });
  assert(localPartLoss.loss > globalPartLoss.loss * 5);
  assert(globalPartLoss.missingForeground > 0);
  assert(compareRgba(source, transparency, { width, height }).alphaMassRatio < 0.51);
});

test('vanished foreground is penalized with the original denominator; empty regions stay finite', () => {
  const { width, height, source } = fixture();
  const empty = Buffer.alloc(source.length);
  const vanished = compareRgba(source, empty, { width, height });
  assert(vanished.vanishedForeground);
  assert(vanished.loss > 0.4);
  assert.equal(vanished.missingForeground, 1);
  const emptyMetric = compareRgba(empty, empty, { width, height });
  assert(emptyMetric.emptyReference);
  assert.equal(emptyMetric.loss, 0);
  const emptyRegion = compareRgba(source, empty, { width, height, regions: [{ x: 2, y: 2, width: 0, height: 0 }] });
  assert(emptyRegion.regions[0].empty);
  assert(Number.isFinite(emptyRegion.loss));
  assert.equal(differenceRgba(source, empty).length, source.length);
  assert.throws(() => compareRgba(source, empty.subarray(4), { width, height }), /equal-sized/);
});
