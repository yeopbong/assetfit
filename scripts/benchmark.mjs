import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { benchmarkGlbSearch, GLB_PIPELINE_VERSION } from '../src/glb.mjs';
import { createRenderer, RENDERER_VERSION } from '../src/renderer.mjs';
import { METRIC_VERSION } from '../src/metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxEvaluations = Number(process.env.ASSETFIT_BENCHMARK_EVALUATIONS ?? 8);
if (!Number.isInteger(maxEvaluations) || maxEvaluations < 6 || maxEvaluations > 32) throw new Error('Benchmark evaluations must be an integer from 6 to 32.');
const seeds = [11, 22, 33];
const budgetRatios = [0.25, 0.5, 0.75, 0.9];
const usage = { width: 256, height: 256, dpr: 1, weight: 1 };
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(root, 'artifacts', 'benchmark-runs', runId);
await fs.mkdir(outputDir, { recursive: true });
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());

function portable(value) {
  if (typeof value === 'string' && value.startsWith(root + path.sep)) return path.relative(root, value).split(path.sep).join('/');
  if (Array.isArray(value)) return value.map(portable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item)]));
  return value;
}
function summarize(run, sourceBytes, surrogate) {
  const valid = run.candidates.filter(candidate => candidate.valid && Number.isFinite(candidate.loss));
  const best = [...valid].sort((a, b) => (a.loss + 0.2 * a.bytes / sourceBytes) - (b.loss + 0.2 * b.bytes / sourceBytes))[0];
  const firstFive = run.candidates.slice(0, 5).map(candidate => ({ id: candidate.id, bytes: candidate.bytes, valid: candidate.valid, loss: candidate.loss }));
  const candidates = run.observations.filter(event => event.event === 'candidate');
  const timings = { initializationMs: 0, transformMs: 0, encodeMs: 0, validationMs: 0, evaluationMs: 0, surrogateTrainingMs: 0 };
  for (const event of run.observations) {
    if (event.event === 'initialization') timings.initializationMs += event.costMs;
    if (event.event === 'proposal') timings.surrogateTrainingMs += event.trainingMs ?? 0;
  }
  for (const event of candidates) for (const key of ['transformMs', 'encodeMs', 'validationMs', 'evaluationMs']) timings[key] += event.candidate.diagnostics?.timings?.[key] ?? 0;
  return {
    method: run.method, surrogate, seed: run.seed, logicalEvaluations: run.logicalEvaluations,
    validCandidates: valid.length, failedCandidates: run.candidates.length - valid.length,
    physicalMs: run.physicalMs, timings, firstFive,
    stopped: run.observations.findLast(event => event.event === 'search-complete')?.stopped ?? 'unknown',
    surrogateProposals: run.observations.filter(event => event.phase === 'evolution-surrogate-proposal' && event.event === 'proposal').length,
    bestObjective: best ? best.loss + 0.2 * best.bytes / sourceBytes : null,
    best: best ? { id: best.id, bytes: best.bytes, loss: best.loss } : null,
    budgets: budgetRatios.map(ratio => {
      const budget = Math.floor(sourceBytes * ratio);
      const selected = valid.filter(candidate => candidate.bytes <= budget).sort((a, b) => a.loss - b.loss || a.bytes - b.bytes)[0];
      return { ratio, budget, feasibleInArchive: Boolean(selected), selected: selected ? { id: selected.id, bytes: selected.bytes, loss: selected.loss } : null };
    }),
    failures: candidates.filter(event => !event.candidate.valid).map(event => ({ id: event.candidate.id, error: event.candidate.diagnostics.error })),
  };
}

const started = performance.now();
const rendererStarted = performance.now();
const renderer = await createRenderer({ workDir: outputDir, signal: abort.signal });
const report = { schemaVersion: 1, runId, status: 'running',
  protocol: { sources: ['Duck', 'Avocado'], seeds, maxEvaluations, usage, budgetRatios,
    rankingObjective: 'search loss + 0.2 * candidate bytes / source bytes; lower is better',
    initialization: 'Each run independently measures original and all four uniform quality vectors before other proposals.',
    methods: ['uniform', 'random', 'greedy', 'evolutionary without surrogate', 'evolutionary with ridge surrogate'],
    surrogate: 'Ridge fitted only to observations from the current method and seed; predictions select the next physical measurement.',
    cache: 'No shared observation or score cache. Every method pays for fresh encoding, validation, file reload and rendering.',
    heldout: 'Benchmark comparisons use search-view scores. Final extra-view checks are exercised by project export, not used for benchmark ranking.',
    uniformStop: 'Uniform quality has exactly original plus four levels. It stops after five observations with an unused allowance; no duplicate work is invented.',
    selectionRule: 'Sources, seeds, budgets, objective and limit were fixed before running. All runs, failures and unfilled budgets are preserved.' },
  versions: { node: process.versions.node, glb: GLB_PIPELINE_VERSION, renderer: RENDERER_VERSION, metric: METRIC_VERSION },
  environment: { platform: process.platform, architecture: process.arch, logicalCpus: os.availableParallelism(), rendering: renderer.environment },
  costs: { rendererStartupMs: performance.now() - rendererStarted, originalReferenceMs: 0 }, assets: [] };
const checkpoint = async () => {
  const text = JSON.stringify(portable(report), null, 2) + '\n';
  await fs.writeFile(path.join(outputDir, 'benchmark.json'), text);
  await fs.writeFile(path.join(root, 'artifacts', 'benchmark.json'), text);
};
try {
  for (const name of report.protocol.sources) {
    const sourcePath = path.join(root, 'examples', 'sources', `${name}.glb`);
    const source = await fs.readFile(sourcePath);
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const context = await renderer.reference(sourcePath, [usage]);
    report.costs.originalReferenceMs += context.durationMs;
    const entry = { name, sourceHash, sourceBytes: source.length, referenceMs: context.durationMs, settingsHash: context.settingsHash, runs: [], summaries: [] };
    report.assets.push(entry);
    for (const surrogate of [false, true]) {
      const result = await benchmarkGlbSearch({ sourcePath,
        outputDir: path.join(outputDir, name, surrogate ? 'surrogate-on' : 'surrogate-off'),
        asset: { usages: [usage], constraints: {} },
        evaluate: file => renderer.evaluate(file, context), signal: abort.signal,
        methods: surrogate ? ['evolutionary'] : ['uniform', 'random', 'greedy', 'evolutionary'], seeds,
        settings: { maxEvaluations, useSurrogate: surrogate, evaluationKey: context.settingsHash },
        onObservation: event => { if (event.event === 'search-complete') console.log(`${name} ${event.method} seed=${event.seed} surrogate=${surrogate}: ${event.attempts} observations, ${event.validCandidates} valid, ${Math.round(event.totalMs)} ms`); },
      });
      for (const run of result.results) {
        entry.runs.push({ ...run, surrogate });
        entry.summaries.push(summarize(run, source.length, surrogate));
      }
      await checkpoint();
    }
    const expected = JSON.stringify(entry.summaries[0].firstFive);
    entry.commonInitializationVerified = entry.summaries.every(summary => JSON.stringify(summary.firstFive) === expected);
    if (!entry.commonInitializationVerified) throw new Error(`${name}: common initialization differed across methods or seeds.`);
    await checkpoint();
  }
  report.status = 'complete';
} catch (error) {
  report.status = abort.signal.aborted ? 'cancelled' : 'failed';
  report.error = error.message;
  throw error;
} finally {
  await renderer.close();
  report.costs.totalMs = performance.now() - started;
  report.costs.methodPhysicalMs = report.assets.flatMap(asset => asset.summaries).reduce((sum, summary) => sum + summary.physicalMs, 0);
  report.costs.logicalEvaluations = report.assets.flatMap(asset => asset.summaries).reduce((sum, summary) => sum + summary.logicalEvaluations, 0);
  await checkpoint();
  const compact = { ...report, assets: report.assets.map(({ runs, ...asset }) => asset),
    detailedArtifact: path.relative(root, path.join(outputDir, 'benchmark.json')).split(path.sep).join('/') };
  await fs.writeFile(path.join(root, 'docs', 'benchmark-results.json'), JSON.stringify(portable(compact), null, 2) + '\n');
}
console.log(`Benchmark ${report.status}: ${report.costs.logicalEvaluations} logical observations; ${(report.costs.totalMs / 1000).toFixed(1)} seconds end to end.`);
