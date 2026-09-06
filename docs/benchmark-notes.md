# GLB search benchmark

The benchmark compares measured candidate archives under a fixed local protocol. It does not establish a universal visual-quality ranking or claim that evolutionary search always beats simpler methods.

Run `pnpm benchmark` after installing dependencies and fetching the documented sample sources. `ASSETFIT_BENCHMARK_EVALUATIONS` can change the per-run observation ceiling from the default eight; the chosen value is recorded. Chrome must be installed, or run `pnpm exec playwright install chromium`. Rebuilding the figure from the committed observations does not require rerunning this benchmark.

The sources are the Khronos Duck and Avocado sample GLBs, identified by SHA-256 in the results. The declared view is 256 × 256 physical pixels at DPR 1. Three original-derived search cameras, lighting, tone mapping and foreground-weighted RGBA metric settings are identical across all methods. Each evaluation encodes from the original, writes a real GLB, validates its format and preserved semantics, reloads that file, renders it, and measures it.

All five method variants receive the same source, decision variables, independent initialization and maximum observation allowance. Each method separately measures the original and four uniform quality vectors. Random search, a measured coordinate-greedy baseline, evolutionary search without a surrogate, and evolutionary search with a fitted ridge surrogate then propose additional vectors. The uniform strategy has only those five defined vectors and stops when exhausted. Its unused allowance is explicit; duplicates are not invented to fill a table. This is a comparison under the same maximum allowance, not equal realized evaluation counts or equal wall time.

Both assets expose two adjustable variables: one unique geometry group and one eligible color texture. Each has five levels, from original to stronger reduction; the full joint decision space has 25 vectors. The original is `[0, 0]`, and uniform initialization measures `[1, 1]` through `[4, 4]`. Other methods may mix levels between geometry and texture. Geometry target ratios are 1, 0.75, 0.50, 0.28 and 0.12; color texture scales are 1, 1, 0.75, 0.50 and 0.25, with JPEG qualities 88, 76, 60 and 42 for changed textures. Avocado's normal and occlusion/roughness/metallic maps remain unchanged. No user locks or extra protected regions were added in these benchmark runs. The raw initialization events retain the actual resource identities and protection sets.

The seeds are fixed at 11, 22 and 33. No winning seed is selected. There is no shared observation or metric cache between methods. Original reference images are a common fixed calibration and their physical cost is reported separately. Every method pays its own encoding, validation, reload and rendering costs, including initialization and failed candidates. Surrogate warmup is included in the common first five observations; actual fitting time and the number of surrogate proposals are recorded. Ridge predictions rank future proposals only, and never replace measured quality scores. The exploration bonus is a heuristic, not a confidence interval.

Results report every run and failures, plus the best measured candidate under fixed budgets of 25%, 50%, 75% and 90% of the original asset bytes. Missing solutions mean no feasible candidate was found in that run's measured archive. A common scalar diagnostic, `loss + 0.2 × bytes / source bytes`, provides a budget-independent comparison; lower is better. It is an engineering tradeoff, not a perceptual percentage. Initialization equality across all methods and seeds is checked from actual bytes and scores.

The benchmark uses only search-view scores. It makes no claim of unseen-view or arbitrary-lighting generalization. The local project workflow separately performs final held-out rendering checks after allocation; those measurements do not choose benchmark proposals or rank its archives.

## Recorded results

The corrected historical run used `assetfit-glb-1.0.1`, `three-180-fixed-v1` and `rgba-reference-v1` on macOS arm64, Node 24.19.0 and Chrome 152.0.7977.76 with SwiftShader. It completed all 222 logical observations with 222 valid evaluations in 88.8 seconds end to end. The current release uses a later GLB pipeline version; these are historical measurements, not a rerun of the entire release-version matrix. The benchmark makes no cross-platform reproducibility guarantee.

The release audit read all 222 corresponding physical GLB files and matched their actual byte counts and SHA-256 hashes to both the candidate and renderer records. The common first five hashes and losses matched exactly across every method and seed. The table reports mean `loss + 0.2 × bytes / source bytes` over all three seeds; lower is better.

![Measured search objectives for Duck and Avocado, showing all three seeds and each method mean](images/benchmark-comparison.png)

| Method | Duck | Avocado |
| --- | ---: | ---: |
| Uniform | 0.048819 | 0.130575 |
| Random | 0.048819 | 0.127657 |
| Measured greedy | 0.048819 | 0.125996 |
| Evolutionary, surrogate off | 0.048819 | 0.129365 |
| Evolutionary, ridge on | 0.048819 | 0.126090 |

Uniform already found the best value of this particular scalar objective for Duck, although other methods found better losses at some fixed byte budgets. On Avocado, measured greedy had the best mean scalar value. Ridge-assisted evolution improved over evolution alone, and did not beat greedy. The ridge variant actually fitted and used three surrogate proposals per run, for 18 proposals across both assets and all seeds. Its post-initialization vector sequence differs from the matching surrogate-off run in all six asset/seed pairs. Those records, together with the fitted-model proposal path in `src/glb.mjs`, establish that the switch affected proposals. These small results support retaining the simple baselines and a switchable surrogate; they do not justify a universal search-advantage claim.

No run found an Avocado candidate within the 25% or 50% budgets. Data maps are deliberately preserved and still occupy physical GLB bytes. Those cells are explicitly unfilled in the results. Runtime varies with the candidates selected, and methods ran in a fixed order; the single-session timings are accounting measurements, not a controlled speedup claim.

## Evaluation and cost accounting

The 222 evaluations are `2 assets × 3 seeds × (5 uniform + 4 methods × 8)` across 30 independent runs. They contain **36 unique output hashes**, 18 per asset. Many outputs are repeated across methods or seeds, including the common initialization. Those were independently encoded and measured with paid physical work, not cache hits. Within each run, proposal vectors are unique. The corrected record contains zero failures, cache observations or retries; 222 evaluations must not be described as 222 distinct outputs or as evidence of algorithmic superiority.

| Method | Evaluations per run | Duck mean seconds/run | Avocado mean seconds/run |
| --- | ---: | ---: | ---: |
| Uniform | 5 | 1.289 | 2.500 |
| Random | 8 | 1.914 | 4.202 |
| Measured greedy | 8 | 2.000 | 4.201 |
| Evolutionary, surrogate off | 8 | 1.909 | 4.032 |
| Evolutionary, ridge on | 8 | 2.067 | 3.764 |

Method physical time totals 83.633 seconds. It includes 0.507 seconds of setup across 30 runs, 83.091 seconds of candidate work, 0.00509 seconds of ridge fitting and proposal ranking, and 0.029 seconds of other method overhead. Candidate work includes encoding, file write/read, validation, reload and rendering; diagnostic phase timings are subsets of this time. Do not add nested timings again. Common renderer startup costs 3.614 seconds, original reference rendering 1.326 seconds, and orchestration/shutdown 0.238 seconds, bringing the total to 88.811 seconds. Fixed run order, different measured candidates and a single local session prevent interpreting the timing table as a controlled speedup result.

## Evidence and reproduction

- `docs/benchmark-results.json` contains the existing compact run summaries and environment.
- `docs/benchmark-observations.json` retains every original observation event, including measured bytes, hashes, recipes, per-view metrics, proposal vectors and costs. Repeated image paths and renderer metadata are omitted; numerical measurements are unchanged. The full source report SHA-256 and the physical-file verification result are recorded in its provenance. This portable record is included in the repository, so the chart does not depend on a private artifact directory.
- `docs/benchmark-audit.json` is derived from those observations: counts, run objectives, costs, matched initialization and paired surrogate proposals. Its 30 objectives were checked against the existing summary values.
- `scripts/plot-benchmark.py` recomputes the audit and exports PNG/SVG. `docs/benchmark-chart-contract.json` records the chart's grain, scale and comparison rules.
- `artifacts/benchmark.json` and its timestamped directory retain the full local run and actual output files. These large files are excluded from version control. Running `pnpm benchmark` generates a new physical run in the current environment; it does not recreate an old machine's timings.

To regenerate the audit and chart only, from the repository root:

```bash
python3 -m venv .cache/chart-env
.cache/chart-env/bin/python -m pip install -r scripts/plot-benchmark-requirements.txt
.cache/chart-env/bin/python scripts/plot-benchmark.py
```

Python 3.12 and the pinned plotting dependencies were used for the shipped figure. They are documentation tools and are not needed to run AssetFit. If the full local artifact archive is available, `.cache/chart-env/bin/python scripts/plot-benchmark.py --extract artifacts/benchmark.json` also rereads every candidate file and rebuilds the portable observations. This flag is deliberately not needed by a clean clone.

The benchmark script records partial failure or cancellation instead of filling missing combinations with invented values. No new experimental matrix was run for the release audit.

The first full engineering run is retained in `docs/benchmark-initial-run.json`. It exposed a geometry-adapter bug: a reused three-component scratch array overflowed the last two-component UV entry in Duck. That run completed 222 logical observations in 67.9 seconds, including 81 failed Duck candidates and no failed Avocado candidates. The adapter was corrected, its pipeline version advanced to 1.0.1, and a no-vertex-color regression was added. The current results rerun the complete fixed protocol with the correction; the earlier failures are not omitted from the record.

Metric behavior is tested with exact identity, actual image blur, silhouette removal, a disappearing small part, alpha damage, fully vanished foreground, invisible RGB, and empty regions. `ASSETFIT_RENDER_TESTS=1 node --test tests/renderer.test.mjs tests/project-glb.test.mjs` runs actual GLB checks for repeatability, usage invalidation, a narrowed silhouette, a removed shared-mesh detail, and a model moved outside the original cameras. It also cancels a real project after two observations, reloads persisted state, resumes without repeating completed measurements, and verifies final asset bytes, held-out rendering, cumulative cost, and parent-node lock propagation. Routine `pnpm test` skips those browser tests unless explicitly enabled.
