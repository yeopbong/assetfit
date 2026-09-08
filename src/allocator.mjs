export const ALLOCATOR_VERSION = 'sparse-pareto-v1';
export const ALLOCATION_LIMITS = Object.freeze({ maxFrontierStates: 250_000, maxExpandedStates: 2_000_000 });

/** @typedef {{id:string, bytes:number, valid?:boolean, metrics:{loss:number}|null}} CandidateInput */
/** @typedef {{id:string, priority?:number, sourceBytes?:number, originalBytes?:number, bytes?:number, candidates:CandidateInput[]}} AssetInput */
/** @typedef {{id:string, bytes:number, loss:number, rawLoss:number, candidate:CandidateInput}} PreparedCandidate */
/** @typedef {{id:string, priority:number, sourceBytes:number|undefined, candidates:PreparedCandidate[]}} PreparedAsset */
/** @typedef {{table:PreparedAsset[], totalPriority:number, minimumBytes:number|null, failure:string|null}} PreparedTable */
/** @typedef {{bytes:number,loss:number,indices:number[]}} FrontierState */
/** @typedef {{maxFrontierStates?:number,maxExpandedStates?:number}} AllocationOptions */

/** @param {string} resource @param {number} statesVisited @param {number} storedStates @param {{maxFrontierStates:number,maxExpandedStates:number}} limits */
function allocationLimit(resource, statesVisited, storedStates, limits) {
  return Object.assign(new Error(`Exact allocation resource limit reached (${resource}). No solution or infeasibility claim was produced; the measured candidate archive is preserved. Reduce the project size or explicitly increase solver limits.`), {
    name: 'AllocationLimitError', code: 'EXACT_ALLOCATION_LIMIT', statesVisited, storedStates, limits,
  });
}

/** @param {unknown} value @param {string} label @returns {number} */
function bytes(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer in bytes.`);
  return value;
}

/** @param {unknown} value @param {string} label @returns {number} */
function priority(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a finite non-negative number.`);
  return value;
}

/** @param {AssetInput[]} assets @param {number} budget @param {Record<string,number>} weights @returns {PreparedTable} */
function prepare(assets, budget, weights) {
  bytes(budget, 'Budget');
  if (!Array.isArray(assets)) throw new TypeError('Assets must be an array.');
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) throw new TypeError('Weights must map asset IDs to priorities.');
  const ids = new Set();
  const table = assets.map((asset) => {
    if (!asset || typeof asset.id !== 'string' || !asset.id || ids.has(asset.id)) throw new TypeError('Each physical asset must have a unique non-empty string ID.');
    ids.add(asset.id);
    if (!Array.isArray(asset.candidates)) throw new TypeError(`Asset ${asset.id} has no candidate archive.`);
    const weight = priority(Object.hasOwn(weights, asset.id) ? weights[asset.id] : (asset.priority ?? 1), `Priority for ${asset.id}`);
    const candidateIds = new Set();
    const candidates = asset.candidates.filter((candidate) => candidate.valid !== false).map((candidate) => {
      if (typeof candidate.id !== 'string' || !candidate.id || candidateIds.has(candidate.id)) throw new TypeError(`Asset ${asset.id} has duplicate or invalid candidate IDs.`);
      candidateIds.add(candidate.id);
      const cost = bytes(candidate.bytes, `Candidate ${candidate.id} cost`);
      const loss = priority(candidate.metrics?.loss, `Candidate ${candidate.id} loss`);
      if (!Number.isFinite(loss * weight)) throw new RangeError('Weighted loss exceeds numeric range.');
      return { id: candidate.id, bytes: cost, loss: loss * weight, rawLoss: loss, candidate };
    });
    return { id: asset.id, priority: weight, sourceBytes: asset.sourceBytes ?? asset.bytes ?? asset.originalBytes, candidates };
  });
  const totalPriority = table.reduce((sum, asset) => sum + asset.priority, 0);
  if (!Number.isFinite(totalPriority)) throw new RangeError('Total priority exceeds numeric range.');
  let minimumBytes = 0;
  for (const asset of table) {
    if (!asset.candidates.length) return { table, totalPriority, minimumBytes: null, failure: `No valid measured candidate for ${asset.id}.` };
    minimumBytes += Math.min(...asset.candidates.map((candidate) => candidate.bytes));
    bytes(minimumBytes, 'Minimum combined asset bytes');
  }
  return { table, totalPriority, minimumBytes, failure: minimumBytes > budget ? 'Current constraints and candidate archive contain no configuration within this asset-byte budget.' : null };
}

/** @param {PreparedTable} prepared @param {number} budget @param {string} method @param {boolean} exact */
function failureResult(prepared, budget, method, exact) {
  return { feasible: false, selected: {}, bytes: null, loss: null, normalizedLoss: null, budget, minimumBytes: prepared.minimumBytes, exact, method, version: ALLOCATOR_VERSION, reason: prepared.failure, scope: 'Generated candidate table at current priorities; not a proof over ungenerated outputs.' };
}

/** @param {PreparedAsset[]} table @param {number[]} indices @param {number} budget @param {number} totalPriority @param {string} method @param {boolean} exact @param {Record<string,unknown>} extra */
function result(table, indices, budget, totalPriority, method, exact, extra = {}) {
  const selected = Object.fromEntries(table.map((asset, i) => [asset.id, asset.candidates[indices[i]].id]));
  let totalBytes = 0;
  let loss = 0;
  const contributions = table.map((asset, i) => {
    const candidate = asset.candidates[indices[i]];
    totalBytes += candidate.bytes;
    bytes(totalBytes, 'Selected asset bytes');
    loss += candidate.loss;
    return { assetId: asset.id, candidateId: candidate.id, bytes: candidate.bytes, priority: asset.priority, loss: candidate.rawLoss, weightedLoss: candidate.loss };
  });
  if (totalBytes > budget) throw new Error('Internal allocation error: actual candidate byte sum exceeds budget.');
  if (!Number.isFinite(loss)) throw new RangeError('Total weighted loss exceeds numeric range.');
  return { feasible: true, selected, bytes: totalBytes, loss, normalizedLoss: totalPriority ? loss / totalPriority : 0, budget, slack: budget - totalBytes, exact, method, version: ALLOCATOR_VERSION, contributions, scope: 'Generated candidate table at current priorities.', ...extra };
}

/** @template {{bytes:number,loss:number}} T
 * @param {T[]} states
 * @returns {T[]} */
function pareto(states) {
  states.sort((a, b) => a.bytes - b.bytes || a.loss - b.loss);
  let lowestLoss = Infinity;
  return states.filter((state) => {
    if (state.loss >= lowestLoss) return false;
    lowestLoss = state.loss;
    return true;
  });
}

/** @param {AssetInput[]} assets @param {number} budget @param {Record<string,number>} weights @param {AllocationOptions} options */
export function allocate(assets, budget, weights = {}, options = {}) {
  const started = performance.now();
  const limits = {
    maxFrontierStates: bytes(options.maxFrontierStates ?? ALLOCATION_LIMITS.maxFrontierStates, 'Maximum stored frontier states'),
    maxExpandedStates: bytes(options.maxExpandedStates ?? ALLOCATION_LIMITS.maxExpandedStates, 'Maximum expanded states'),
  };
  if (!limits.maxFrontierStates || !limits.maxExpandedStates) throw new RangeError('Exact allocator resource limits must be positive integers.');
  const prepared = prepare(assets, budget, weights);
  const { table, totalPriority, minimumBytes } = prepared;
  if (prepared.failure) return failureResult(prepared, budget, 'exact-sparse-pareto', true);
  /** @type {FrontierState[]} */
  let frontier = [{ bytes: 0, loss: 0, indices: [] }];
  let statesVisited = 1;
  let peakFrontier = 1;
  const remaining = Array(table.length + 1).fill(0);
  for (let i = table.length - 1; i >= 0; i--) remaining[i] = remaining[i + 1] + Math.min(...table[i].candidates.map((candidate) => candidate.bytes));
  for (let i = 0; i < table.length; i++) {
    const candidates = pareto(table[i].candidates.map((candidate, index) => ({ ...candidate, index })));
    /** @type {Map<number,FrontierState>} */
    const nextByBytes = new Map();
    for (const state of frontier) {
      for (const candidate of candidates) {
        statesVisited++;
        if (statesVisited > limits.maxExpandedStates) throw allocationLimit('expanded states', statesVisited, nextByBytes.size, limits);
        if (candidate.bytes > budget - remaining[i + 1] - state.bytes) continue;
        const cost = state.bytes + candidate.bytes;
        const loss = state.loss + candidate.loss;
        if (!Number.isFinite(loss)) throw new RangeError('Total weighted loss exceeds numeric range.');
        const previous = nextByBytes.get(cost);
        if (!previous || loss < previous.loss) {
          nextByBytes.set(cost, { bytes: cost, loss, indices: [...state.indices, candidate.index] });
          if (nextByBytes.size > limits.maxFrontierStates) throw allocationLimit('stored byte states', statesVisited, nextByBytes.size, limits);
        }
      }
    }
    frontier = pareto([...nextByBytes.values()]);
    peakFrontier = Math.max(peakFrontier, frontier.length);
  }
  const best = frontier.reduce((best, state) => state.loss < best.loss || (state.loss === best.loss && state.bytes < best.bytes) ? state : best);
  return result(table, best.indices, budget, totalPriority, 'exact-sparse-pareto', true, { minimumBytes, statesVisited, peakFrontier, limits, durationMs: performance.now() - started });
}

/** @param {AssetInput[]} assets @param {number} budget @param {Record<string,number>} weights */
export function allocateGreedy(assets, budget, weights = {}) {
  const started = performance.now();
  const prepared = prepare(assets, budget, weights);
  const { table, totalPriority, minimumBytes } = prepared;
  if (prepared.failure) return failureResult(prepared, budget, 'measured-greedy', false);
  if (minimumBytes === null) throw new Error('Missing minimum candidate costs.');
  const indices = table.map((asset) => asset.candidates.reduce((best, candidate, i, all) => candidate.bytes < all[best].bytes || (candidate.bytes === all[best].bytes && candidate.loss < all[best].loss) ? i : best, 0));
  let totalBytes = minimumBytes;
  while (true) {
    /** @type {{i:number,j:number,additionalBytes:number,benefit:number,efficiency:number}|null} */
    let best = null;
    for (let i = 0; i < table.length; i++) {
      const current = table[i].candidates[indices[i]];
      for (let j = 0; j < table[i].candidates.length; j++) {
        const candidate = table[i].candidates[j];
        const additionalBytes = candidate.bytes - current.bytes;
        const benefit = current.loss - candidate.loss;
        if (benefit <= 0 || additionalBytes > budget - totalBytes) continue;
        const efficiency = additionalBytes <= 0 ? Infinity : benefit / additionalBytes;
        if (!best || efficiency > best.efficiency || (efficiency === best.efficiency && benefit > best.benefit)) best = { i, j, additionalBytes, benefit, efficiency };
      }
    }
    if (!best) break;
    indices[best.i] = best.j;
    totalBytes += best.additionalBytes;
  }
  return result(table, indices, budget, totalPriority, 'measured-greedy', false, { minimumBytes, durationMs: performance.now() - started });
}

/** @param {AssetInput[]} assets @param {number} budget @param {Record<string,number>} weights */
export function allocateProportional(assets, budget, weights = {}) {
  const started = performance.now();
  const prepared = prepare(assets, budget, weights);
  const { table, totalPriority, minimumBytes } = prepared;
  if (prepared.failure) return failureResult(prepared, budget, 'original-size-proportional', false);
  if (minimumBytes === null) throw new Error('Missing minimum candidate costs.');
  const proportions = table.map((asset) => bytes(asset.sourceBytes ?? Math.max(...asset.candidates.map((candidate) => candidate.bytes)), `Original size for ${asset.id}`));
  const proportionSum = proportions.reduce((sum, value) => sum + value, 0);
  bytes(proportionSum, 'Combined original sizes');
  const remaining = budget - minimumBytes;
  const indices = table.map((asset, i) => {
    const minimum = Math.min(...asset.candidates.map((candidate) => candidate.bytes));
    const extra = proportionSum ? Number(BigInt(remaining) * BigInt(proportions[i]) / BigInt(proportionSum)) : Math.floor(remaining / (table.length || 1));
    const limit = minimum + extra;
    return asset.candidates.reduce((best, candidate, index, all) => candidate.bytes <= limit && (best < 0 || candidate.loss < all[best].loss || (candidate.loss === all[best].loss && candidate.bytes < all[best].bytes)) ? index : best, -1);
  });
  return result(table, indices, budget, totalPriority, 'original-size-proportional', false, { minimumBytes, durationMs: performance.now() - started });
}

export const greedyAllocate = allocateGreedy;
export const proportionalAllocate = allocateProportional;
