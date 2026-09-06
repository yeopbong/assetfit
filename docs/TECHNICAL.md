# Technical reference

## Project representation and accounting

`src/project.mjs` owns the common workflow for images, GLBs, and mixed projects. Each asset has a stable ID, a source SHA-256, an internal copied source, capability diagnostics, usages, constraints, priority, a complete candidate archive, and observations. The canonical source remains unchanged. A candidate records its physical file, measured integer bytes and hash, generating parameters, validity, per-usage metrics, diagnostics, versions and physical processing cost.

Import uses the resolved physical source path to merge repeated references. A separate path containing identical content remains a separate asset because the current delivery writes both files. Embedded image bytes are already included in their containing GLB. There is no conditional cross-asset deduplication in the allocator.

Browser uploads do not expose trustworthy physical source identity, so independently uploaded files remain independently charged even when names and hashes match. Additional usages on an existing asset represent repeated references explicitly.

The budget is `sum(selectedCandidate.bytes)` over assets. Every asset must select exactly one valid candidate. Minimum dimensions, original lock, supported formats, alpha handling and GLB semantic checks are hard gates before optimization. A legal original is an ordinary measured candidate; one source file being individually smaller than a project budget does not skip joint allocation.

## Image pipeline

`src/images.mjs` uses Sharp 0.34.3 and its bundled libvips. It inspects the decoder metadata and source hash, rejects unsupported/animated/high-bit-depth inputs, creates source reference rasters, then generates a bounded list of candidates from the original file. The default maximum is eight proposals: exact original, a native-size lossless conversion where permitted, and native/intermediate/compact JPEG or WebP tiers. Alpha sources exclude JPEG. Fewer proposals may exist when formats or locks narrow the space.

New encodes apply EXIF orientation, interpret colors in sRGB, preserve alpha, and remove ancillary metadata. The original candidate copies source bytes verbatim, including original metadata. A lossless request forces original display dimensions and requires exact equality of decoded normalized RGBA buffers, rather than assuming that a nominally lossless encoder was sufficient. `lockOriginal` allows only the exact source file, and that file must still satisfy the selected compatibility profile and dimensions.

No output is cropped or repacked into an atlas. `contain`, `cover` and `fill` describe the display evaluator. Encoded dimensions follow the original aspect ratio, with the integer rounding required for raster dimensions. Minimum dimensions and `preserveDimensions` constrain the resulting files. Transparency preservation retains alpha capability; resized transparency edges may change. Exact content requires lossless/original-dimension constraints or whole-file locking.

A usage is shaped as follows:

```json
{
  "width": 512,
  "height": 512,
  "dpr": 1,
  "fit": "contain",
  "weight": 1,
  "regions": [{ "x": 0.2, "y": 0.1, "width": 0.3, "height": 0.2, "weight": 4 }]
}
```

Missing image usages default visibly to 512 × 512 at DPR 1 with contain fit. Region coordinates are normalized against the declared display rectangle. With `unit: "pixels"`, coordinates are CSS/display pixels and are multiplied by DPR for metric evaluation. Regions change local evaluation priority. They do not provide encoder-level region losslessness. Asset usages are aggregated by their declared weighted mean.

Each generated file is written, hashed, measured from disk, inspected, decoded, and compared at every declared display size. A verified lossless conversion must also match the full source raster. Failure observations keep their cost and diagnostic. Encodes are serial; cancellation is checked between encoding and evaluation steps. A running native encode may finish before cancellation is observed.

Evaluation first decodes the complete native image to normalized RGBA, then resizes the raw source and candidate rasters with the same kernel. This avoids codec-specific shrink-on-load behavior making pixel-identical lossless formats compare differently. Each usage saves actual reference and candidate PNGs and a fixed 4× difference image. These preview/report files are separate from candidate visual-asset byte costs.

## GLB representation and protection

`src/glb.mjs` parses the original binary GLB and examines its JSON before importing it into glTF Transform. The supported subset is self-contained glTF 2.0, static triangle primitives, standard PBR materials and embedded PNG/JPEG textures. `KHR_texture_transform` is explicitly supported. Animation, skins, morph targets, external resources, other extensions and nontriangle primitives are rejected instead of removed.

Geometry variables correspond to unique mesh/primitive resources. Multiple nodes instancing one mesh do not create duplicate optimization variables. Texture variables correspond to embedded image resources and are classified by every material slot referencing them. A texture used by a normal/metallic-roughness/occlusion slot, an alpha-sensitive material, or with alpha channels is retained. Only eligible opaque base-color and emissive resources can be resized and JPEG encoded.

Object protection starts from stable node IDs, includes descendants, and propagates through geometry accessors and shared texture references. The capability/protection records expose affected objects. Locked content is never split into a new resource to bypass protection. A semantic snapshot verifies hierarchy, transforms, names, extras, material relations, supported texture references and attribute semantics. Protected geometry also checks decoded attributes and topology; protected and data images check image bytes.

The per-primitive adapter uses public `MeshoptSimplifier.simplifyWithAttributes` or `simplify` APIs with border locking. It does not depend on an invented mesh filter in a global transform. Retained vertices are compacted, and rewritten attributes receive private accessors so they cannot corrupt a different primitive sharing the source accessor. This is a measured lossy simplification step. Outputs use core glTF buffer data and require no extra mesh-compression decoder.

## Structured 3D search

Each unlocked geometry/eligible texture group has a discrete level from 0 through 4. Geometry triangle targets are 1.0, 0.75, 0.50, 0.28 and 0.12 of the original count, subject to simplifier limits. Texture scale/quality levels are recorded in `GLB_LEVELS`; preservation is level 0. The search vector can assign distinct levels to different resources, so the method can explore geometry/texture interactions rather than a single global quality slider.

All search methods begin with the original and up to four common uniform levels. The default cap is 12 logical measurements per GLB; local project configuration permits 1–64. Each new candidate is derived from original source content, written as a GLB, measured, validated with glTF Validator, reloaded with glTF Transform, checked against its semantic snapshot, and then reloaded and rendered by the browser evaluator. Predictions never substitute for this process.

The evolutionary method selects measured parents with tournaments under varying byte/loss tradeoffs, crosses their resource levels, mutates a dimension, and proposes fresh vectors. Optional ridge regression is fitted from measured candidate losses and sizes using level, squared-level and adjacent-interaction features. It ranks a proposal pool with a distance-based exploration term. This heuristic is not a calibrated probability of success. `settings.useSurrogate: false` disables it while keeping the evolutionary pipeline.

The random and measured-greedy strategies use the same candidate domain, evaluator, initialization and logical cap. The uniform baseline may exhaust its smaller proposal space earlier. Benchmark archives keep independent observations per method and seed. Neither a later method nor its surrogate sees a previous method's answers. The benchmark protocol documents costs and all fixed seeds, including losing methods.

## Shared display-space proxy

`src/metrics.mjs` defines `rgba-reference-v1`. For the same-sized original and candidate RGBA displays, it computes:

```text
display loss = 0.55 × RGB difference
             + 0.20 × edge difference
             + 0.15 × alpha difference
             + 0.10 × silhouette difference
```

RGB compares colors composited over black and white, so hidden RGB beneath zero alpha does not create spurious damage. Edges compare local luma gradients. Alpha is the absolute alpha difference. Silhouette compares foreground membership at the declared alpha threshold. Original foreground receives weight 1 and background weight 0.03 when foreground exists. User regions increase their fixed local weights; overlapping priorities take their maximum. The reference denominator does not shrink when candidate content disappears. Empty references, missing foreground, alpha mass and empty rectangles are recorded explicitly.

Images contribute the usage-weighted mean of their display losses. GLBs average their declared search views within each usage and then take the usage-weighted mean. Empty original views cannot dilute visible-view damage; a model invisible in every original search camera is rejected. A candidate with vanished foreground in a view fails the evaluator's validity check. The count of 3D cameras therefore does not multiply a GLB's project importance.

This common engineering proxy makes a defined cross-type objective possible; it is not a universal measure of human quality. It does not recognize text, infer semantic backgrounds, prove readability, or guarantee that a low average loss preserves critical content. Region priorities are user-provided. Use hard constraints for exact UI, text, pixel art, or atlas requirements.

## Fixed rendering and additional inspection

`src/renderer.mjs` launches a local Three.js browser renderer and only serves explicitly registered GLB files and bundled code. It blocks external page requests. Original bounds determine camera centers, distances, clipping planes and lighting. Candidate bounds are never used to refit the comparison camera.

Default 3D usage is 256 × 256 at DPR 1. Three automatically generated orbit views are used for search. Up to eight saved cameras per usage can replace them; perspective and explicit-scale orthographic cameras are represented in the usage record. The renderer uses the recorded RoomEnvironment, lights, sRGB output, ACES filmic tone mapping, exposure and transparent background for both original and candidate. Renderer, metric, browser and graphics environment are recorded.

Two different reference camera positions are reserved for additional checking. Their candidate renders, when requested after allocation, are kept separate from search measurements. They must not be fed back into candidate selection and still be called unseen validation. Free viewer rotation helps manual inspection but cannot establish correctness at every angle, light or background.

## Exact project allocation and baselines

For asset `a`, priority `w[a]`, and candidate loss `L[a,c]`, the solver minimizes:

```text
sum over assets a of w[a] × L[a, selected[a]]
subject to sum over assets a of bytes[a, selected[a]] <= budget
and exactly one valid candidate per asset
```

The result's `loss` is this weighted sum. `normalizedLoss` divides it by the sum of asset priorities. The normalization is constant during a solve and does not change the selected solution. Image/GLB per-usage aggregation has already occurred inside each candidate's loss.

`src/allocator.mjs` implements exact sparse Pareto dynamic programming with safe integer byte costs. At each asset, it expands the current frontier, keeps the best state at each exact byte sum, then removes states dominated in both byte cost and current weighted loss. Suffix minimum costs avoid exploring states that cannot fit the remaining assets. A frontier is recreated for every solve, and the input archive is never mutated. The solver does not bucket bytes, silently approximate frontiers, or claim optimality outside the generated table.

To bound memory and work on larger projects, `ALLOCATION_LIMITS` defaults to 250,000 distinct stored byte states per stage and 2,000,000 expanded states per solve. The storage limit is enforced during expansion before pruning, not only on the final frontier. Hitting a limit throws `AllocationLimitError` with code `EXACT_ALLOCATION_LIMIT` and measured state counts; it returns no feasible or infeasible result and does not mutate the candidate archive. A direct core caller can explicitly change these limits with the fourth argument: `allocate(assets, budgetBytes, priorities, { maxFrontierStates, maxExpandedStates })`. A completed solve remains exact within its stated scope.

The UI also allows explicit replacement with another valid measured candidate while enforcing the actual total budget. Such an allocation has `exact: false` and method `user-selected-alternative`. It is a manual choice, not an approximation of the optimizer's objective. Recipe manual selections store output hashes so replay can restore the same chosen versions. Re-solving after a budget or priority change returns to ordinary exact table allocation.

The measured-greedy baseline starts from the smallest valid file per asset and repeatedly chooses the available improvement with the highest loss reduction per extra byte. The proportional baseline reserves every asset's minimum candidate bytes, distributes the remaining budget according to original source size, and selects each asset's best candidate under its quota. Quota arithmetic uses integer division; no baseline can acquire a rounded-down file cost.

When minimum valid candidate costs already exceed the budget, this proves infeasibility only for the present candidate table. The user-facing result states that the current constraints and exploration did not find a feasible configuration. It does not claim that no possible future encoding could fit.

## Cache, persistence and replay

The project epoch includes source hash, usage conditions, constraints, generator settings and application version. Asset priority is intentionally outside it, because existing per-asset losses can be reweighted exactly without recomputing pixels. Changes to dimensions, DPR, fit, cameras, local priorities, constraints or evaluation settings invalidate the relevant archive. Full candidate data is preserved across priority-only solves.

Image cache keys additionally contain encoder/libvips/metric versions and normalized usage settings. A resumable image candidate is reused only if its actual file size and hash match. Completed observations survive cancellation. Failed and repeated physical attempts retain their costs. GLB search stores proposal vectors, random states, logical attempts and generation keys so retries do not obtain a new uncharged search budget.

`project.json` is saved atomically after progress. The service can reopen an interrupted project. Source inputs and exported files are not automatically cleaned up. Temporary or candidate archives may occupy more disk space than the final delivery; the project byte budget does not constrain workspace storage.

Recipes bind exact source hashes, names and asset mapping, plus usages, constraints, budgets and search settings. Replay creates a new managed project and compares selected output hashes with historical selections. A mismatch is reported instead of silently changing history. Policies contain reusable defaults and omit old asset mappings. Cross-machine graphics and future encoder changes may produce different results; the recorded environment and pinned dependency lockfile are part of reproducibility.

Recipe environment records include Node, architecture, Sharp/libvips versions, renderer and metric versions. Replay rejects mismatches in the recorded renderer, metric or libvips gate. Candidate-specific encoder and browser environment records give additional context; this gate does not assert universal byte equality across hardware. Output hashes are still checked.

## Delivery and verification

`src/delivery.mjs` checks candidate validity, archive freshness, actual source output hashes and sizes before copying selected assets. It measures the resulting visual byte sum and requires it to match allocation accounting. The manifest maps stable assets to real output filenames. The HTML and JSON reports contain actual choices, per-use measurements, explicit settings and the next larger measured alternative with lower loss, when one exists.

Manifest/recipe/policy/report bytes and actual ZIP bytes are reported separately from visual assets. The ZIP is physically generated before its size is reported. No ZIP-size cap is inferred from the asset-byte budget. Names are escaped in HTML; first-party reports omit private absolute source paths.

## Verification and reproducibility commands

```sh
pnpm test
pnpm typecheck
pnpm build
ASSETFIT_RENDER_TESTS=1 pnpm exec node --test tests/renderer.test.mjs
pnpm examples
pnpm verify:demo
pnpm benchmark
```

Focused allocator tests compare 300 seeded small tables with exhaustive enumeration, including invalid candidates, zero priorities, ties and byte boundaries. Image tests perform actual encodes, exact original comparisons, EXIF rotation, alpha/lossless checks, usage-size evaluation, cache key changes and cancellation. Project tests exercise real export/replay/cache flows and integrity failures. Renderer tests are opt-in and execute Chrome; benchmark runs are separately recorded because repeated rendering is more expensive than normal unit checks.

`tsconfig.json` applies full strict checking to the actual allocator and metric JavaScript implementations through JSDoc as well as the shared TypeScript interfaces. `scripts/check.mjs` runs the JavaScript parser over source, browser, script and test modules. Other runtime modules rely on those syntax checks and behavioral tests; they are not claimed to have complete static type coverage.

Inspect current command results and generated experiment records for pass counts and measured times. These documents do not assign performance advantages to an unrun experiment or promise that the more complex search method always wins.
