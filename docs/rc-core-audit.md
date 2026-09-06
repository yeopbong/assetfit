# Release candidate core audit

The existing mixed processing pipeline uses real candidate files and one joint allocation problem. This bounded audit repaired project portability and processing-status defects. It did not change encoding, measurement, candidate search, or allocation semantics.

## Trace and evidence

The pre-existing small case contains Duck, the NASA astronaut photograph, and a protected detail sheet: 966,966 original asset bytes. All 23 valid candidate files were independently checked against recorded byte sizes, SHA-256 values, source hashes, and recipes. Re-solving their shared candidate table reproduced 73,556, 122,342, and 207,202 selected asset bytes. Each corresponding delivery passed independent hash, byte-sum, image decode, and GLB validation checks. These are historical small-case checks, not evidence of performance on typical MB-scale inputs; the release case is documented separately.

The compact, machine-readable record is [rc-core-audit.json](rc-core-audit.json). It contains source hashes, every checked candidate recipe and hash, selections, fixes, and the actual validation commands. Machine-specific project paths and duplicate binary outputs are omitted.

Code inspection and existing regression coverage confirm:

- Images are encoded to files and decoded for evaluation under the declared size, DPR, fit, and region weights.
- GLB proposals are written, read back, validated, loaded again through the document parser, checked for semantic preservation, and passed by filename to the renderer. Search uses fixed original-derived viewing conditions; held-out views are separately recorded.
- Shared mesh/accessor and texture references propagate protection. Whole-asset original locks retain original bytes. A physical asset with multiple usages is charged once; distinct copied files remain separate assets.
- Both asset types enter the same exact integer-byte allocation table. Asset priority changes re-solve that table; usage, camera, region, protection, generator, renderer, and metric settings participate in candidate invalidation.
- Export copies the selected real files, verifies their bytes and hashes, and independently reopens them. ZIP and report bytes are accounted separately. The proxy loss is an engineering objective, not a human visual-quality percentage.

## Repairs and affected historical evidence

1. **Relative output directories:** a relative CLI output root could persist absolute GLB candidate and render references. Project creation, processing, and export now normalize directory arguments. The existing real-render cancellation test now also moves the project directory and verifies a new delivery from that location. Existing project JSON that already contains absolute references is not automatically migrated; its candidate bytes and measurements remain valid at the recorded location. Newly generated projects use portable managed references.
2. **Failed processing reported as complete:** a damaged locked-original image candidate could make every physical encode fail while the asset and project reported completion. An asset with no valid candidates and actual processing errors now reports failure. All failed assets produce `failed`; mixed failed and completed assets produce `partial`. Recovery clears stale errors. A failed asset stays in the joint problem and its lock remains intact.
3. **CLI exit status:** returned `failed` and `partial` results now exit with code 2; cooperative cancellation exits with 130. The JSON result is retained. A successfully completed search whose finite candidate table cannot satisfy the budget exits with 0 and explicitly reports `feasible: false`; this does not claim that ungenerated outputs are globally impossible. Command errors remain code 1; verification mismatches remain code 2.

No valid historical candidate file, evaluation value, or benchmark result was invalidated by these repairs. An old `complete` status in the specific all-processing-failed condition, or an old zero CLI exit code by itself, is not valid proof of processing success.

## Validation scope

The core run passed 46 existing checks after the path repair, including real Chromium rendering, shared-reference protection, cancellation/resume, fixed-view evaluation, moved-project export, and exact allocation against exhaustive enumeration. After the processing-status change, the 19 project checks passed. The amended failure regression then passed with its additional partial-failure assertion. Two CLI regressions passed using actual child processes, including SIGINT after a real candidate was measured. These runs overlap; their counts must not be added.

Reproduce the focused repairs with:

```bash
pnpm exec node --test tests/project.test.mjs tests/cli.test.mjs
ASSETFIT_RENDER_TESTS=1 pnpm exec node --test tests/project-glb.test.mjs
```

The second command requires the documented local rendering browser. The recorded runs used macOS arm64 and the installed Node.js/Chromium environment; they do not establish cross-platform byte-identical replay. The existing UI source now includes separate partial and failed processing notices; actual browser acceptance is recorded in the release verification rather than inferred from this source inspection.
