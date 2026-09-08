# Technical reference

## Assets and allocation

`src/project.mjs` manages source copies, usages, constraints, priorities, candidate files and observations. Each physical asset selects exactly one valid candidate. Repeated references to an imported path share an asset; separate imports remain separate delivery files. Embedded texture bytes count inside the GLB.

`src/allocator.mjs` minimizes:

```text
sum over assets a of priority[a] × loss[a, selected[a]]
subject to sum over assets a of bytes[a, selected[a]] <= budget
and exactly one valid candidate per asset
```

The solver uses sparse Pareto dynamic programming with integer byte costs. It keeps the best state at each exact byte sum, prunes dominated states and uses remaining minimum costs to skip combinations that cannot fit. Each solve rebuilds its frontier without changing the candidate archive. `normalizedLoss` divides the objective by total asset priority.

`ALLOCATION_LIMITS` defaults to 250,000 stored states per stage and 2,000,000 expanded states per solve. Exceeding a limit throws `AllocationLimitError` with code `EXACT_ALLOCATION_LIMIT`. Core callers can set the fourth argument to `allocate(assets, budgetBytes, priorities, { maxFrontierStates, maxExpandedStates })`.

Measured greedy starts with minimum-size candidates and chooses loss improvements per additional byte. Proportional allocation reserves minimum sizes, then distributes remaining bytes by original file size. The UI also permits feasible manual selections, recorded with `exact: false` and method `user-selected-alternative`.

## Image usages and protection

`src/images.mjs` uses Sharp to decode, encode and compare files. The default cap is eight proposals: exact original, permitted lossless conversion and native/intermediate/compact JPEG or WebP variants. Alpha inputs exclude JPEG. New encodes apply orientation, normalize to sRGB and strip ancillary metadata.

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

Images default to 512 × 512, DPR 1 and `contain`. `contain`, `cover` and `fill` affect display evaluation; files retain their aspect ratio. Regions use normalized display coordinates, or CSS pixels with `unit: "pixels"`. Usage losses combine by weighted mean.

`preserveDimensions` retains original dimensions. `lossless` also requires identical decoded normalized RGBA pixels. `lockOriginal` permits only the exact source bytes. Minimum dimensions and format constraints still apply to locked inputs.

Source and candidate are fully decoded to RGBA before identical display resizing. Each usage records reference, selected and fixed 4× difference images. These report images are separate from asset-byte costs.

## GLB generation and rendering

`src/glb.mjs` accepts the static subset listed in [the user guide](USAGE.md#supported-assets-and-protections). It inspects raw GLB JSON before loading it with glTF Transform. Object locks include descendants and propagate through shared geometry, accessors and textures.

Each unlocked geometry or eligible texture resource has a level from 0 through 4. Triangle targets are 1, 0.75, 0.50, 0.28 and 0.12 of the original count. Texture scales are 1, 1, 0.75, 0.50 and 0.25; changed JPEG qualities are 88, 76, 60 and 42. Normal/ORM and alpha-sensitive textures retain original bytes. The geometry adapter uses meshoptimizer's public simplification APIs with border locking and private rewritten accessors.

Search begins with the original and four uniform levels. The default allowance is 12 logical evaluations per GLB, configurable from 1 to 64. Random, measured greedy and evolutionary methods share the candidate domain and evaluator. Evolution uses tournaments, crossover and mutation; optional ridge regression ranks proposals using measured losses and sizes. Set `settings.useSurrogate: false` to disable it.

Every candidate is written, byte-counted, hashed, validated, reloaded and checked for preserved hierarchy, materials, attributes and protected content before rendering. The complete archive includes failed observations. See [the benchmark](benchmark-notes.md) for saved comparisons.

`src/renderer.mjs` serves registered files to a local Three.js renderer. Original bounds fix camera positions, clipping and lighting. GLB usages default to 256 × 256 at DPR 1 and three search views; up to eight saved cameras can replace them. Additional post-selection views remain separate from search scores. Free rotation supports manual inspection.

## Display loss

`src/metrics.mjs` defines `rgba-reference-v1`:

```text
display loss = 0.55 × RGB difference
             + 0.20 × edge difference
             + 0.15 × alpha difference
             + 0.10 × silhouette difference
```

RGB compares black and white compositing. Edges compare local luma gradients. Original foreground has weight 1 and background 0.03 when foreground exists; overlapping region priorities take their maximum. Weights and denominators remain fixed when candidate content disappears.

GLBs average search views within each usage, then combine usages by weighted mean. Empty original views cannot dilute visible-view damage, and vanished candidate foreground fails validity checks. The score measures differences in these conditions, not human visual quality or text readability.

## Persistence, export and replay

The project epoch includes source hashes, usages, constraints, generation settings and application version. Budget and asset priority changes reuse candidates; changes to viewing conditions or protections invalidate the relevant archive. Cache reuse checks actual file bytes and hashes. GLB observations retain proposal vectors and random states for resume.

`project.json` is saved atomically. Cancellation preserves completed candidates; native encoding may finish its current step before stopping. Sources and exports are not automatically removed.

Export rechecks archive freshness, candidate hashes, sizes and the total visual byte sum. Reports include selections, settings and available lower-loss alternatives. ZIP and metadata bytes are measured separately.

Recipes bind exact source mappings and selections. Replay creates a new project, checks recorded renderer/metric/libvips compatibility and compares output hashes. Browser, encoder and hardware differences can still affect reproduction. Policies transfer defaults without old asset mappings.
