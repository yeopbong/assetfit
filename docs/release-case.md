# A measured mixed collection

This release case processes a 10.39 MB collection in one project: Microsoft's CC0 Avocado model, a NASA editorial portrait, the NASA Apollo 17 Blue Marble photograph, and an original-locked detail graphic. The roles describe a constructed demonstration brief, not a customer case study. All files, scores, costs and downloads come from the fresh run recorded in [release-case.json](release-case.json).

## Reproduce

Run `node scripts/release-case.mjs` from the repository root after installing the documented dependencies and Chrome. [release-config.json](../examples/release-config.json) declares relative inputs, display sizes, protections, seed 42, twelve GLB observations, up to eight image candidates, and three budgets before generation. Each run creates a fresh managed project. The recipe in each delivery binds exact source hashes and asset mappings; it is distinct from a transferable policy.

The additional photo is credited to NASA / Apollo 17 Crew on its [official individual page](https://apod.nasa.gov/apod/ap220206.html), with provenance corroborated by [NASA's source article](https://www.nasa.gov/image-article/blue-marble-view-from-apollo-17/). Its usage follows [NASA's media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/), with attribution and no endorsement. The original JPEG is 3,000 × 3,002 pixels and 1,438,327 bytes; SHA-256 is `dfc341bd81efcb2d9a22aaee3f92e84b538c4501157b02e16b8dc93c4965f048`. [SOURCES.json](../examples/SOURCES.json) records every asset's individual author, license and hash. No input is upscaled or padded to inflate its byte count.

## Uses and candidates

| Asset | Declared uses | Original bytes | Actual candidates |
| --- | --- | ---: | ---: |
| Avocado.glb | Product model: 320 × 320 @ 1 | 8,110,040 | 12 |
| astronaut.png | Editorial portrait: 320 × 320 @ 1; Byline portrait: 96 × 96 @ 1 | 791,555 | 8 |
| blue-marble.jpg | Earth feature photo: 640 × 640 @ 1 | 1,438,327 | 8 |
| detail.png | Protected detail graphic: 640 × 320 @ 1 | 54,927 | 1 |

The portrait's two uses share one physical asset and one selected file. Usage weights are averaged within the asset. The model uses three original-derived search views; additional final views are evaluated only after allocation. Its normal and metallic-roughness images are retained. The detail graphic remains byte-identical to the original, including its transparency and full dimensions.

## Joint allocation

Budget sizes were fixed before generation. Each method below receives the same complete valid candidate table, protections and priorities. Lower proxy loss is better; it is not a visual-retention percentage.

| Budget | Limit bytes | Exact selected bytes | Exact proxy loss | Greedy proxy loss | Proportional proxy loss |
| --- | ---: | ---: | ---: | ---: | ---: |
| lite | 5,500,000 | 5,347,181 | 0.002005 | 0.002005 | 0.005605 |
| standard | 7,000,000 | 6,901,595 | 0.000370 | 0.000370 | 0.002005 |
| high | 9,000,000 | 6,901,595 | 0.000370 | 0.000370 | 0.002005 |

At least one selection changes across the three budgets: **true**. The separately predefined 8,500,000-byte priority check changes both model and image choices between model priority 8 and Earth-photo priority 8: **true**. All three priority outcomes are retained in the JSON, including unchanged choices. This is an exact optimum over this measured archive at each set of weights, not a claim about ungenerated encodings.

A 1,000,000-byte allocation finds no feasible configuration in the measured archive. A separate fresh project locks all four originals, measures those four actual files, fails the 5,500,000-byte budget, and refuses export. No asset is removed and no lock is relaxed. The locked project is retained with its separate physical costs.

The 7,000,000-byte standard and 9,000,000-byte high budgets select the same files because the next strictly better weighted-loss combination in the measured table requires 9,877,623 bytes. All 768 combinations were enumerated; unused budget does not force a quality change.

## Delivery verification and accounting

Every tier's exported files are independently decoded or glTF-validated, byte-counted and hashed. Each exported GLB is also reloaded from its delivery path and rendered under the same final cameras; all three checks match their selected candidate measurements within 1e-9.

| Tier | Visual asset bytes | Metadata bytes | Actual ZIP bytes |
| --- | ---: | ---: | ---: |
| lite | 5,347,181 | 4,629,466 | 8,275,314 |
| standard | 6,901,595 | 4,564,032 | 9,776,413 |
| high | 6,901,595 | 4,564,027 | 9,776,406 |

Asset bytes count selected visual files once per physical output. The independently generated ZIP and metadata are not included in that budget. 1 MB = 1,000,000 bytes; 1 MiB = 1,048,576 bytes.

Measured processing through demo assembly took 33.42 seconds, including the separate lock-failure project, export reloads and demo assembly. Main-project optimization took 19.18 seconds. Main managed-project files occupied 174,723,562 logical filesystem bytes at the recorded inventory; the final assembled demo occupied 102,489,870 bytes. Precise stage times, nested candidate transform/encode/validation/render/training costs, source copies, candidate storage, export storage and total file counts are recorded in JSON. These overlapping accounting views must not be summed twice.

The demo retains complete candidate records, real media files and downloadable manifests/recipes/reports. Identical bytes share a content-addressed preview/archive cache to avoid duplicate storage; this does not create a cross-asset delivery deduction. The browser recomputes budget and priority allocation from precomputed observations. It cannot regenerate candidates or certify new camera conditions without the local program.

The published demonstration includes one ready-made complete standard ZIP, plus every tier's manifest, recipe, policy and report JSON. It retains all real candidates, so its browser can create a fresh ZIP for any feasible allocation. The original local project preserves all three physically verified ZIPs and standalone HTML reports. The publication-only packaging revision moved redundant ZIP/HTML copies out of the published folder without modifying any visual asset or metric. Its measured duration and preserved copy paths are recorded separately in JSON.
