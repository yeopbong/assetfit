import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, allocateGreedy, allocateProportional } from '../src/allocator.mjs';

const candidate = (id, bytes, loss, valid = true) => ({ id, bytes, valid, metrics: { loss } });

function exhaustive(assets, budget, weights = {}) {
  let best = null;
  function visit(index, bytes, loss) {
    if (bytes > budget) return;
    if (index === assets.length) {
      if (!best || loss < best.loss || (loss === best.loss && bytes < best.bytes)) best = { bytes, loss };
      return;
    }
    const asset = assets[index];
    for (const choice of asset.candidates.filter((choice) => choice.valid !== false)) visit(index + 1, bytes + choice.bytes, loss + choice.metrics.loss * (weights[asset.id] ?? asset.priority ?? 1));
  }
  visit(0, 0, 0);
  return best;
}

test('exact integer-byte frontier agrees with exhaustive enumeration on 300 reproducible tables', () => {
  let state = 92761;
  const random = (limit) => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state % limit; };
  for (let trial = 0; trial < 300; trial++) {
    const assets = Array.from({ length: 1 + random(5) }, (_, i) => ({ id: `asset-${i}`, priority: random(5), candidates: Array.from({ length: 1 + random(5) }, (_, j) => candidate(`c-${j}`, random(130), random(100) / 100, random(8) > 0)) }));
    const budget = random(400);
    const expected = exhaustive(assets, budget);
    const actual = allocate(assets, budget);
    assert.equal(actual.feasible, !!expected, `trial ${trial}`);
    assert.equal(actual.exact, true);
    if (expected) {
      assert.ok(Math.abs(actual.loss - expected.loss) < 1e-12, `trial ${trial}`);
      assert.ok(actual.bytes <= budget);
      assert.equal(Object.keys(actual.selected).length, assets.length);
      assert.ok(allocateGreedy(assets, budget).loss >= actual.loss - 1e-12);
      assert.ok(allocateProportional(assets, budget).loss >= actual.loss - 1e-12);
    }
  }
});

test('one-byte boundary cannot be rounded down and invalid candidate is excluded', () => {
  const assets = [{ id: 'a', candidates: [candidate('high', 1025, 0), candidate('small', 1024, 0.1), candidate('illegal', 1, 0, false)] }];
  assert.equal(allocate(assets, 1024).selected.a, 'small');
  assert.equal(allocate(assets, 1023).feasible, false);
  assert.equal(allocate(assets, 1023).minimumBytes, 1024);
  assert.equal(allocate(assets, 1025).selected.a, 'high');
  assert.throws(() => allocate(assets, 1024.9), /integer/);
  assert.throws(() => allocate([{ id: 'a', candidates: [candidate('x', 0.1, 0)] }], 1), /integer/);
});

test('priority recomputation preserves archived alternatives and can redistribute across types', () => {
  const assets = [
    { id: 'image', candidates: [candidate('small', 30, 0.3), candidate('large', 70, 0)] },
    { id: 'glb', candidates: [candidate('small', 30, 0.2), candidate('large', 70, 0)] },
  ];
  const snapshot = JSON.stringify(assets);
  assert.deepEqual(allocate(assets, 100).selected, { image: 'large', glb: 'small' });
  assert.deepEqual(allocate(assets, 100, { glb: 3 }).selected, { image: 'small', glb: 'large' });
  assert.equal(JSON.stringify(assets), snapshot);
});

test('zero priorities, zero-byte assets, tied losses and empty project are well-defined', () => {
  const assets = [{ id: 'zero', priority: 0, candidates: [candidate('big', 10, 0), candidate('small', 0, 1)] }];
  assert.deepEqual(allocate(assets, 10).selected, { zero: 'small' });
  assert.equal(allocate(assets, 10).normalizedLoss, 0);
  assert.equal(allocate([], 0).bytes, 0);
  assert.equal(allocate([], 0).loss, 0);
});

test('malformed costs, IDs, weights and numeric overflow fail explicitly', () => {
  const base = { id: 'a', candidates: [candidate('a', 3, 0)] };
  assert.throws(() => allocate([base, base], 6), /unique/);
  assert.throws(() => allocate([{ ...base, candidates: [candidate('x', 3, NaN)] }], 6), /finite/);
  assert.throws(() => allocate([base], Number.MAX_SAFE_INTEGER + 1), /safe integer/);
  assert.throws(() => allocate([base], 6, { a: -1 }), /non-negative/);
  assert.throws(() => allocate([base], -1), /non-negative/);
  assert.throws(() => allocate([{ id: 'a', candidates: [candidate('x', Number.MAX_SAFE_INTEGER, 0)] }, { id: 'b', candidates: [candidate('x', 1, 0)] }], Number.MAX_SAFE_INTEGER), /safe integer/);
});

test('all methods use safe integer sums near the numeric limit', () => {
  const assets = [{ id: 'a', bytes: 7, candidates: [candidate('x', 4, 1), candidate('y', 7, 0)] }, { id: 'b', bytes: 9, candidates: [candidate('x', 2, 1), candidate('y', 9, 0)] }];
  for (const method of [allocate, allocateGreedy, allocateProportional]) assert.equal(method(assets, Number.MAX_SAFE_INTEGER).bytes, 16);
});

test('exact solver work and memory caps fail explicitly without mutating the candidate archive', () => {
  const assets = [{ id: 'a', candidates: [candidate('small', 1, 1), candidate('middle', 2, 0.5), candidate('large', 3, 0)] }];
  const original = JSON.stringify(assets);
  for (const limits of [{ maxExpandedStates: 2 }, { maxFrontierStates: 1 }]) {
    assert.throws(() => allocate(assets, 3, {}, limits), (error) => error.name === 'AllocationLimitError' && error.code === 'EXACT_ALLOCATION_LIMIT' && /resource limit reached/.test(error.message) && !Object.hasOwn(error, 'feasible'));
  }
  assert.equal(JSON.stringify(assets), original);
  assert.equal(allocate(assets, 3, {}, { maxExpandedStates: 10, maxFrontierStates: 10 }).selected.a, 'large');
  assert.throws(() => allocate(assets, 3, {}, { maxExpandedStates: 0 }), /positive/);
});
