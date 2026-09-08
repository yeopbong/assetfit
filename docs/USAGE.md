# AssetFit user guide

Start with the [installation and browser workflow](../README.md). Run commands below from the repository root.

## Setup and troubleshooting

GLB processing uses Chrome or Playwright Chromium. Install a browser with `pnpm exec playwright install chromium`, or set `ASSETFIT_CHROME="/path/to/chrome"` when starting the application.

After installing and building, macOS users can double-click [start.command](../start.command). The launcher accepts `--port 4319`; `ASSETFIT_NODE="/path/to/node" ./start.command` selects a Node executable. Quote paths containing spaces.

| Situation | Action |
| --- | --- |
| Node or pnpm is missing | Install Node.js 22.13+ and pnpm 11.19.0, then open a new terminal. |
| Dependency installation fails | Fix the reported package or network error and rerun `pnpm install --frozen-lockfile`. |
| The launcher cannot find dependencies or the build | Run `pnpm install --frozen-lockfile` and `pnpm build`. |
| Port 4318 is occupied | Run `pnpm start --port 4319` and use the printed address. |
| Export is unavailable | Regenerate stale candidates, or adjust an infeasible budget or protection setting. |

The service listens on the loopback interface for local use. Installation requires network access; processing runs on your computer.

## Processing and recovery

Closing the browser page leaves a local job running. Cancel in the application or press Ctrl-C during CLI processing to stop between steps. Completed candidates are saved in the managed project.

- **Partial failure:** check the failed imports or processing diagnostics before exporting.
- **Cancelled or interrupted:** reopen the project and resume generation, or use `pnpm cli resume "PROJECT_DIR"`.
- **Stale:** changed display conditions, protections or generation settings require regeneration or reevaluation.
- **No feasible configuration:** the current candidates cannot fit the budget while keeping every asset and constraint.
- **Resource limit:** the archive remains available, but the interrupted solve has no allocation result.

CLI exit codes are 0 for a completed command, 1 for a command error, 2 for failed/partial processing or verification mismatch, and 130 for cancellation. A completed command can report an infeasible allocation in its JSON result.

## Command-line workflow

Budgets are integer bytes. Replace `PROJECT_DIR`, `EXPORT_ID` and `DELIVERY_DIR` below with paths from the command output.

```sh
pnpm cli inspect examples/sources/Duck.glb examples/sources/astronaut.png

pnpm cli optimize examples/sources/Duck.glb examples/sources/astronaut.png \
  --name "Product presentation" --budget 180000 \
  --evaluations 12 --seed 42 --out .assetfit/projects

pnpm cli export "PROJECT_DIR" --tier standard
pnpm cli verify "PROJECT_DIR/exports/EXPORT_ID"
pnpm cli resume "PROJECT_DIR"
```

The CLI imports folders recursively and reports unsupported files individually. Originals are copied into a managed project. Export requires a feasible selection.

To change budgets, save a JSON patch as `budgets.json`:

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

Asset patches use IDs from `project.json`. `constraints: { "preserveDimensions": true, "lossless": true }` protects decoded image pixels; `constraints: { "lockOriginal": true }` keeps the exact source file. See [configuration semantics](TECHNICAL.md) for usages, regions and GLB protection. Budget and importance changes reuse current candidates.

## Supported assets and protections

| Input or setting | Behavior |
| --- | --- |
| Static 8-bit JPEG, PNG, WebP | JPEG, PNG and WebP candidates, with decoded comparisons |
| Orientation and color profiles | New encodes apply EXIF orientation, normalize to sRGB and strip ancillary metadata; original candidates keep exact bytes |
| Transparency | Alpha is retained; resizing can change edges |
| Dimensions, lossless or original locks | Enforce minimum/original dimensions, exact decoded pixels or exact file bytes |
| Image rectangles | Increase comparison priority in those display regions |
| Self-contained static GLB 2.0 | Triangle meshes, multiple nodes/primitives, core PBR, embedded PNG/JPEG and `KHR_texture_transform` |
| GLB object locks | Propagate to descendants and shared geometry/accessors/textures; affected objects are shown |
| GLB textures | Eligible opaque base-color/emissive textures can change; normal/ORM and alpha-sensitive textures keep original bytes |
| Unsupported inputs | Animation, skins, morph targets, external model resources, other GLB extensions, SVG, GIF and high-bit-depth images are rejected |

Default limits are 40 assets, 100 MB per file, 500 MB of source data and 64 million pixels per source image. Evaluation allows 4 million pixels per image usage and 1 million per GLB usage, including DPR. Processing is sequential. Managed projects are limited to 2 GiB including a storage reserve, with 256 MiB of free disk reserved. Existing originals, candidates and exports are not automatically deleted.

The allocator stops at 250,000 stored byte states per stage or 2,000,000 expanded states per solve. A larger budget may select the same files or redistribute bytes between assets.

## Delivery, recipe and policy

The budget sums actual selected visual files. Repeated usages of one asset are charged once; separate imports or delivered files are charged separately. Embedded textures count inside their GLB. ZIP, reports and metadata are additional bytes. One MB is 1,000,000 bytes; one MiB is 1,048,576 bytes.

An export contains `assets/`, `manifest.json`, `recipe.json`, `policy.json`, JSON/HTML comparison reports and `delivery.zip`. You can choose a measured alternative manually if it fits the budget; recipes retain that selection.

A recipe binds source hashes, asset mappings, usages, constraints and selections. Replay creates a separate project and checks selected hashes:

```sh
pnpm cli replay "DELIVERY_DIR/recipe.json" \
  examples/sources/Duck.glb examples/sources/astronaut.png --out .assetfit/replays
```

A policy transfers default usages, constraints, budgets and search settings to new files:

```sh
pnpm cli policy "PROJECT_DIR" policy.json
pnpm cli optimize "path/to/new-photo.jpg" "path/to/new-model.glb" --policy policy.json
```

Browser and encoder versions can affect replay. Loss measures differences under the declared viewing conditions; inspect critical details and use locks where exact preservation matters.

## Examples and development

[The mixed example](release-case.md) supplies a configuration and saved candidates. `pnpm examples` generates the smaller Duck example. Source attribution is in [examples/SOURCES.json](../examples/SOURCES.json).

`pnpm build` creates `dist/` using `examples/release-demo`, or `examples/demo` if the former is absent. Serve it over HTTP. The static application reallocates existing candidates and generates ZIP downloads; new files and viewing conditions require local processing.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm verify:demo
```

Browser checks require Chrome or Playwright Chromium:

```sh
ASSETFIT_RENDER_TESTS=1 pnpm test
pnpm verify:local
```

The [search benchmark](benchmark-notes.md) is optional and separate from installation.
