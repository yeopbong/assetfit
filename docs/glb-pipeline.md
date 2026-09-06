# Static GLB candidate generation

AssetFit treats the complete GLB as one physical asset in the project allocator. Embedded images are already part of that file's measured byte count. A GLB contributes one measured loss after camera observations are averaged within each usage and usages are combined by their stated weights. Adding camera views does not increase the asset's allocation priority.

## Supported input

The original GLB header, chunks and JSON are inspected before a glTF library reads it. The first implementation accepts self-contained glTF 2.0 triangle meshes with core PBR materials, embedded PNG/JPEG textures, multiple nodes, shared meshes, multiple primitives, cameras and the `KHR_texture_transform` extension. Animation, skins, morph targets, non-triangle modes, external buffers/images and other extensions receive explicit diagnostics. Decoder extensions and material extensions are rejected rather than stripped. There is no additional decoder requirement on accepted output.

The Khronos validator runs on the original and every output. Unknown extension objects are diagnosed even when omitted from `extensionsUsed`. Input validation is distinct from support: a valid glTF feature can still be outside the current support matrix.

Names and extras are retained on semantic resources, including raw texture/sampler and PBR metadata that the library's document abstraction omits. A narrow JSON adapter restores those annotations using the unchanged resource mapping, and regression tests inspect the actual output JSON. Metadata attached to storage buffer views is explicitly unsupported: vertex compaction regroups those views, so the pipeline rejects that case rather than silently dropping its annotations.

## Resource groups and protection

A geometry decision identifies one unique mesh primitive. All nodes that instance that mesh use the same decision. A texture decision identifies an embedded image, including all of its material slots and samplers; the same image is not separately rewritten for different texture uses.

An object lock includes descendant nodes, its geometry and its material images. Shared meshes naturally resolve to the same primitive IDs. Locking an accessor propagates through every primitive referencing it. The affected-object list also includes objects that share protected images. Other geometry on an affected object remains adjustable unless it shares a locked resource. Resources are not silently split to bypass a lock.

Every new geometry accessor belongs to the rewritten primitive. The adapter copies all retained components of each original attribute, including UV sets, normals, tangents, vertex colors and custom attributes. It does not modify the source accessor in place. Original accessors are disposed only when no remaining primitive references them. Shared input data can therefore make some candidates larger; actual output bytes, not a geometric size estimate, decide whether they are useful.

Data images used by normal, occlusion or metallic-roughness slots retain exact original encoded bytes. An image shared between a color and data slot also retains its original bytes. Images with an alpha channel, or used by a MASK/BLEND material, are conservatively retained. Only opaque images used exclusively in base-color/emissive slots are eligible for resize and JPEG encoding. Materials, texture coordinates, sampler settings and texture transforms are preserved.

## Geometry adapter

The adapter uses public `MeshoptSimplifier.simplifyWithAttributes()` or `simplify()` APIs from pinned meshoptimizer 0.25.0. It does not assume a `meshFilter` option exists on glTF Transform's public `simplify()` transform, and it does not call hidden transform APIs.

Normals, the first UV set and the first vertex-color set influence the attribute-aware collapse error. Every attribute set is retained in the compacted output, including additional UV/color sets and tangents. Topological borders are locked. The output contains a subset of original vertices and new indices; vertices are not quantized, moved or globally reordered. The default relative collapse-error limit is 0.08. This is an internal proposal constraint, not a visible-quality guarantee. Actual fixed-camera rendered differences determine candidate scores.

The five levels retain target triangle fractions `1, 0.75, 0.5, 0.28, 0.12`. Texture scale levels are `1, 1, 0.75, 0.5, 0.25`; lossy JPEG qualities are `88, 76, 60, 42` with 4:4:4 chroma. Border/attribute constraints can prevent the requested triangle reduction. Requested and actual counts are both reported.

## Search and honest baselines

The default logical allowance is 12 candidate evaluations, including the original. Every method shares the same original plus four uniform-level initialization proposals. The uniform baseline stops when its five distinct configurations are exhausted. Random search samples per-resource levels. Measured greedy search expands unmeasured one-coordinate neighbors of observed configurations sorted by a stated loss/normalized-byte objective. Evolutionary search uses measured parents, tournament selection, crossover, coordinate mutation and random restarts.

The optional surrogate is a ridge model trained from measured observations of loss and normalized bytes. Features include each normalized level, its square, and adjacent-coordinate products. It ranks a pool of fresh evolutionary proposals using a randomly sampled size/loss tradeoff and a distance-based exploration term. Predictions are proposal heuristics, not calibrated uncertainty or output quality. The chosen proposal is always physically generated, validated, reloaded and rendered. Surrogate training time and initialization observations count toward processing records. The comparison script keeps each method's observation archive independent and records all specified seeds; no later method starts with earlier methods' answers.

## Candidate evidence chain

Each candidate starts from the original source bytes, then passes through:

1. Source-derived transforms and an atomic GLB write.
2. Reading that written file to measure its exact bytes and SHA256.
3. Khronos format validation and reloading with glTF Transform.
4. A normalized semantic snapshot comparison covering hierarchy, transforms, names, extras, materials, samplers, texture transforms and attribute definitions. Locked geometry/topology and retained images also require equal data hashes.
5. Loading the written GLB in the fixed-condition browser renderer and computing actual per-usage measurements. Renderer hard-invalid results are rejected.

The original candidate copies source bytes exactly; it is never a re-encoded file labeled original. All measured candidates, including failed attempts, remain in observations. The outer allocator rebuilds a frontier for the current score; the saved archive is not permanently pruned.

Cache keys include source content, resource mapping, protection, uses, generator version, search method, seed, simplification error and the renderer evaluation key. Recorded candidate files must still match their size and hash to resume. An interrupted proposal can be retried under its existing logical slot; new physical retry time remains recorded. Failures and cancellation do not reset the logical allowance. The project separately accumulates end-to-end processing time.

## Validation and limits

Focused tests cover shared meshes and accessors, multiple primitives, duplicate names, node hierarchy and extras, attribute preservation, UV component widths, texture transforms, alpha/data-image retention, original byte identity, unsupported extensions, cancellation and deterministic resumed proposal sequences. Real Duck and Avocado samples provide non-fixture evidence; each source has its own recorded license and hash.

Search cameras and additional validation cameras are recorded separately. Additional checks run after example budget selection, without influencing proposal ranking. A fixed camera set cannot establish appearance from arbitrary views, arbitrary lighting, or every possible downstream renderer. The report shows an engineering image-difference proxy and actual differences; it does not report a percentage of human visual quality retained.
