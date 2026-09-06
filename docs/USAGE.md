# AssetFit user guide

AssetFit helps prepare images and static 3D models for a project with a shared file-size budget. Describe how each asset is displayed, protect important content, generate real output variants, and choose a joint delivery that fits the available asset bytes.

An image and a complete GLB compete in the same allocation. A product model can receive more bytes at one budget while a detail image receives more at another. The optimizer chooses one measured version of every asset; it never deletes an asset to make a budget fit.

This guide assumes commands are run from the repository root. See the [quick start](../README.md) and [release status](RC.md) first.

## Run locally

Requirements: Node.js 22.13 or newer, pnpm 11.19.0, and Chrome or Playwright Chromium for 3D evaluation. Image-only CLI processing does not require a browser. No account, paid API, hosted processing service, or model training service is required.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open **http://127.0.0.1:4318**. The processing service binds to the loopback interface. If Chrome is not installed, install the browser used by the 3D evaluator:

```sh
pnpm exec playwright install chromium
```

Alternatively, set `ASSETFIT_CHROME` to your Chrome executable. The renderer records its browser and graphics environment. Exact cross-machine pixel equality is not promised.

After installing and building, macOS users can also double-click [`start.command`](../start.command), or run `./start.command`. The launcher looks for Node on PATH and in a local dependency-runtime cache; `ASSETFIT_NODE="/path/to/node" ./start.command` chooses an explicit executable. A clean installation should provide Node on PATH or set this variable; it does not require an existing cache. The launcher checks Node's version and requires the installed dependencies and static build. Open the loopback address printed in its terminal.

The normal workflow is to create a project, import files or the bundled sample, set usages and protections, choose a total budget, run processing, inspect the selected outputs, and export a delivery. Closing the browser page does not cancel the background job. Use the cancel control or Ctrl-C during CLI optimize/resume to stop between processing steps; completed candidates and observations are saved.

## Setup and troubleshooting

The release was validated on macOS arm64 with Node 24.19.0, pnpm 11.19.0 and Chrome 152.0.7977.76. Node 22.13 is the declared minimum, not a separately verified runtime. Linux and Windows are unverified. The examples below use a POSIX shell.

| Situation | Action |
| --- | --- |
| `node` or `pnpm` is not found | Install the required runtime/package manager, open a new terminal, and check `node --version` and `pnpm --version` before installing project dependencies. |
| The first dependency installation fails | Read the first failing package or registry/network error. Restore the indicated access or dependency, then rerun `pnpm install --frozen-lockfile`. Do not delete the lockfile or switch package managers to hide the failure. |
| A native image encoder or build binary fails to load | Confirm your Node version and architecture. Reinstall with the committed lockfile after fixing the reported installation problem; an unsupported platform is not a verified configuration. |
| GLB processing cannot find a browser | Install Chrome or run `pnpm exec playwright install chromium`. For a nonstandard executable, start with `ASSETFIT_CHROME="/path/to/chrome" pnpm start`. |
| Port 4318 is occupied | Run `pnpm start --port 4319`, then use the printed address. The launcher also accepts `./start.command --port 4319`. |
| The launcher says dependencies or the build are missing | Run `pnpm install --frozen-lockfile` and `pnpm build` from the repository root, then start again. |
| A path contains spaces | Quote each whole path, for example `cd "my projects/assetfit"`. Keep `cd` and the launch command on separate lines. |
| A budget or protection change leaves export unavailable | Save the conditions and generate or resume candidates if they are stale. If no valid combination fits the current table, choose a different budget or explicitly revise the constraints. Locks are never automatically removed. |

For the macOS launcher, from the directory containing the checkout:

```sh
cd assetfit
./start.command
```

Initial dependency and optional browser installation require network access. Processing your inputs runs locally after those dependencies are available. The application is a loopback service for one user's project work, not a public processing server.

## Processing states and recovery

Candidate generation and budget feasibility are separate results. A completed search can still have no valid combination under a requested budget. The UI reports that finite-archive result; it is not proof that no possible encoder setting could succeed.

- **Partial failure:** accepted inputs and usable candidates remain available, while failed imports or processing are reported. Review the diagnostics before treating the delivery as complete for your intended input set.
- **Cancelled or interrupted:** finished candidates and observations remain in the managed project. Reopen the project and choose **Generate / resume candidates**, or use the CLI `resume` command. Missing outputs may require a real retry, which is recorded separately from prior completed observations.
- **Stale:** display dimensions, DPR, views, regions, protection or generation settings changed. Old measurements are retained for traceability, but cannot be exported as current results until the required regeneration or evaluation completes.
- **No feasible configuration:** the available valid table cannot fit the requested bytes with the current constraints. The result does not drop a resource, change a lock or represent the project as successfully exported.
- **Resource limit:** the allocator or managed storage guard stopped at its declared limit. The retained archive remains available; the interrupted solve makes no optimality or feasibility claim.

Closing only the browser page leaves a running local job active. Stopping the local service ends access to the workspace; its saved project can be reopened after restart. CLI exit codes are 0 for a completed command, 1 for a command error, 2 for failed/partial processing or a verification mismatch, and 130 for cancelled processing. Feasibility is reported in the result JSON independently of command completion.

## Command-line workflow

All budgets in the CLI are integer bytes. The `optimize` command prints the created project directory, which is used by later commands. In the examples below, replace `PROJECT_DIR`, `EXPORT_ID` and `DELIVERY_DIR` with values from the actual output; quoted placeholders are not literal project names.

```sh
pnpm cli inspect examples/sources/Duck.glb examples/sources/astronaut.png

pnpm cli optimize examples/sources/Duck.glb examples/sources/astronaut.png \
  --name "Product presentation" --budget 180000 \
  --evaluations 12 --seed 42 --out .assetfit/projects

pnpm cli export "PROJECT_DIR" --tier standard
pnpm cli verify "PROJECT_DIR/exports/EXPORT_ID"
pnpm cli resume "PROJECT_DIR"
```

The example budget above is a command example, not a measured feasibility claim. If the current candidate archive has no legal combination below the requested budget, the result says so and export is disabled. Original files smaller than a project budget are still considered jointly with the other assets.

Importing a folder through the CLI processes its files recursively. Unsupported inputs produce per-file diagnostics while accepted inputs remain usable. Original inputs are copied into a managed project directory and are never overwritten.

To set multiple budgets or usage constraints, pass a JSON patch:

```json
{
  "budgets": [
    { "name": "lite", "bytes": 120000 },
    { "name": "standard", "bytes": 200000 },
    { "name": "high", "bytes": 400000 }
  ]
}
```

```sh
pnpm cli configure "PROJECT_DIR" budgets.json
pnpm cli solve "PROJECT_DIR"
```

Asset patches use the stable IDs in `project.json`. For example, a precise UI image can use `constraints: { "preserveDimensions": true, "lossless": true }`; a whole-file lock uses `constraints: { "lockOriginal": true }`. A usage includes `width`, `height`, `dpr`, `fit`, `weight`, and optional `regions`. See [the technical reference](TECHNICAL.md) for the complete semantics. Budget and asset-priority changes can reuse the current candidate archive; changing viewing conditions or protections requires regeneration or reevaluation.

## What the budget means

**Asset bytes are the sum of the actual selected visual files.** One MB is 1,000,000 bytes; one MiB is 1,048,576 bytes. The allocator uses safe integer bytes and does not round file costs down into KB buckets.

- Multiple references to one imported physical path share one asset and one byte charge. Their usages are combined.
- Browser uploads are distinct physical imports when identity cannot be established safely. Use an asset's additional usages to declare repeated references without duplicating its delivery file.
- Distinct delivered files are charged separately even when their contents match.
- Embedded GLB textures are already part of the GLB file size. An independently delivered copy also occupies bytes.
- Manifest, recipe, policy, report, and actual ZIP size are reported separately.

This budget is not HTTP transfer size, first-page download cost, GPU memory, frame rate, or a page-loading guarantee. A ZIP is generated and measured, but the project budget is not a ZIP-size limit.

## Supported assets and protections

| Input or feature | Current behavior |
| --- | --- |
| Static JPEG, PNG, WebP with 8-bit channels | Real Sharp encodes and decoded evaluation; JPEG, PNG and WebP output profiles |
| EXIF orientation and embedded color profile | Orientation is applied and new encodes normalize to sRGB; ancillary metadata is stripped. Original retains exact bytes |
| Transparency | Never converted to JPEG or otherwise flattened; local edge changes from resizing remain possible |
| Text, pixel art, UI, atlases | User-set minimum dimensions, original dimensions, verified lossless output, and whole-file original lock |
| Image rectangles | Local metric priority in display coordinates; not a promise of region-level lossless coding |
| Self-contained static GLB 2.0 | Triangle meshes, multiple nodes/primitives, shared resources, core metallic-roughness PBR, embedded PNG/JPEG |
| GLB hierarchy and materials | Names, extras, transforms, material references, UVs, normals, tangents, colors and supported texture semantics are checked after writing |
| GLB protection | Object locks propagate through shared geometry/accessors and textures; affected objects are reported |
| GLB textures | Opaque base-color and emissive textures may change; normal/ORM, shared data-slot textures and alpha-sensitive textures retain original bytes |
| GLB extensions | `KHR_texture_transform` is supported; other extensions are rejected before conversion, including decoder-dependent inputs |
| Animation, skins, morph targets, external GLB resources, SVG, GIF and high-bit-depth images | Explicitly unsupported; not silently stripped or flattened |

Default project limits are 40 assets, 100 MB per source file, and 500 MB of source data. Source images are limited to 64 million pixels. Project configuration limits each image usage raster to 4 million pixels and each GLB usage raster to 1 million pixels. Dimensions multiplied by DPR determine the evaluation raster; an oversized request is rejected rather than silently evaluated at a smaller size. Processing is sequential to bound concurrent memory use. Before new measurements, a conservative space check reserves source and raster storage; a managed project is limited to 2 GiB including that reserve, and at least 256 MiB of free disk remains reserved. Existing originals, candidates and exports are never automatically deleted.

## How outputs are compared

Images and GLBs are compared in declared 2D viewing conditions using the same reference-based engineering proxy: RGB differences, edge differences, alpha differences, and silhouette changes. Original foreground and user rectangle weights stay fixed. GLB evaluation reloads the written file and uses cameras, lighting and bounds established from the original model. Camera count does not multiply an asset's project priority.

Lower loss is better under these declared conditions. It is not a human-aesthetic score, a perceptual percentage, or a guarantee that text is readable. Use explicit protections for critical graphics and inspect the actual comparisons. New cameras, display dimensions, DPR, regional weights, or metric definitions require reevaluation.

The allocator is exact over the generated valid candidate table and the current asset priorities. It does not claim to find the best possible encoding outside that finite table. All candidates remain archived; each solve builds a temporary score-specific Pareto frontier. The technical reference explains the objective, search, baselines and limits.

You can inspect a measured alternative and explicitly replace an asset's selected version if the resulting delivery remains within budget. This becomes a **user-selected** allocation with `exact: false`; it carries no optimality claim. Changing the budget or priorities solves the table again. Exported recipes retain explicit manual selections for replay.

## Delivery, recipe and policy

Each export contains actual selected files in `assets/`, a mapping in `manifest.json`, source-bound `recipe.json`, reusable `policy.json`, machine-readable `report.json`, an HTML report, and `delivery.zip`. Export rechecks file hashes and the total byte sum. The verification command checks the independent delivery files without requiring the original project.

A **recipe** binds exact input hashes, source names, stable asset mapping, usage settings, constraints and selections. Replay creates a separate project and reports whether rebuilt selected hashes match; it does not overwrite the previous delivery.

```sh
pnpm cli replay "DELIVERY_DIR/recipe.json" \
  examples/sources/Duck.glb examples/sources/astronaut.png --out .assetfit/replays
```

A **policy** carries default usages, constraints, budgets and search settings across projects. It does not carry old asset IDs or identify objects in an unrelated model.

```sh
pnpm cli policy "PROJECT_DIR" policy.json
pnpm cli optimize "path/to/new-photo.jpg" "path/to/new-model.glb" --policy policy.json
```

## Examples, static demo and checks

Bundled real assets and their attribution are recorded under `examples/sources`; generated files and measurements are produced by the example workflow. The static demo uses a clearly identified precomputed candidate archive. Its budget and asset-priority controls run the allocator in the browser. Static hosting cannot generate new candidates or reevaluate changed cameras and usages; use the local application for those operations.

The source manifest is [`examples/SOURCES.json`](../examples/SOURCES.json). It records each source URL, author, individual license, source bytes and SHA-256. The release case combines the Khronos Avocado model, NASA astronaut and Blue Marble images, and the original detail-sheet fixture; the small Duck case remains available for quick checks. The purpose-built detail sheet tests transparency and exact-pixel constraints; it is not the only evidence for the application.

```sh
pnpm examples
pnpm build
pnpm verify:demo
pnpm test
pnpm typecheck
```

`dist/` is the static build. The build selects `examples/release-demo` when it is present and otherwise uses the small `examples/demo` archive. It can be served by an ordinary static web server without the local processing API; the demo's outputs are real downloadable files. Nothing is uploaded or published by these commands.

Both local and static ZIP exports include an inspectable HTML report with the actual reference, selected output and amplified difference images, plus the manifest, recipe, policy and measured records. Static measurements remain labeled as precomputed when exported.

The [release case](release-case.md) provides the full mixed-case configuration, real budget results, actual costs and output checks. The [release report](RC.md) records the clean installation and static hosting checks. The static demo uses precomputed candidates and performs allocation live; uploaded files require the local application. No public Demo address is claimed until a deployed address has been checked.

Real browser renderer tests are opt-in because they launch Chrome and perform GLB renders:

```sh
ASSETFIT_RENDER_TESTS=1 pnpm test
pnpm verify:local
pnpm benchmark
```

The benchmark compares uniform, random, measured greedy, evolutionary search without the surrogate, and evolutionary search with its measured-data ridge surrogate. It uses fixed independent seeds and records every run, including cases where simple baselines win. See [the benchmark protocol](benchmark-notes.md) and the generated `docs/benchmark-results.json` when present. Candidate generation, renderer initialization, failures, search, and project allocation are separately recorded; solver time alone is not the end-to-end cost.

These commands serve different purposes; a routine installation does not require the full benchmark. The committed historical comparison can be regenerated from its portable observations without encoding or rendering again. Its optional Python plotting environment is separate from application dependencies.

Type checking covers the actual shared allocator and metric implementations with strict JSDoc checking, plus the common TypeScript interfaces. A separate syntax check covers the remaining runtime, browser and script modules; runtime and browser tests exercise their behavior. The application is not represented as fully statically typed.

## Limits that affect decisions

Finite candidates can leave gaps between useful sizes, and larger budgets may return the same combination. Increasing a total budget does not guarantee that every individual asset becomes larger. Exact dynamic programming can grow expensive: the default limits are 250,000 stored byte states per stage and 2,000,000 expanded states per solve. Reaching either limit stops with an explicit resource-limit error, preserves the candidate archive, and makes no feasibility or optimality claim. No hidden approximation is applied. The local service is intended for individual project work, not a public multiuser processing service.

3D checks cover only the recorded cameras and lighting. Separate held-out views, when recorded after selection, are additional checks rather than proof for arbitrary angles. Browser and encoder versions matter for reproduction. A low average loss cannot replace protection constraints or visual review of critical details.
