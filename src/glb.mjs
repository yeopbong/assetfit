import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { NodeIO } from '@gltf-transform/core';
import { KHRTextureTransform } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import validator from 'gltf-validator';

export const GLB_PIPELINE_VERSION = 'assetfit-glb-1.0.2';
export const GLB_LEVELS = Object.freeze([
  { ratio: 1, textureScale: 1, quality: null },
  { ratio: 0.75, textureScale: 1, quality: 88 },
  { ratio: 0.5, textureScale: 0.75, quality: 76 },
  { ratio: 0.28, textureScale: 0.5, quality: 60 },
  { ratio: 0.12, textureScale: 0.25, quality: 42 },
]);
const ALLOWED_EXTENSIONS = new Set(['KHR_texture_transform']);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const stable = (value) => JSON.stringify(canonical(value));
const clone = (value) => structuredClone(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function checkCancelled(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Task cancelled.'), { name: 'AbortError' });
}
function createIO() { return new NodeIO().registerExtensions([KHRTextureTransform]); }

/** Inspect the original JSON before allowing any library to interpret extensions. */
export function parseGlb(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('Invalid GLB header.');
  if (buffer.readUInt32LE(4) !== 2) throw new Error('Only GLB version 2 is supported.');
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error('GLB declared length does not match file bytes.');
  let json;
  let bin;
  let cursor = 12;
  while (cursor < buffer.length) {
    if (cursor + 8 > buffer.length) throw new Error('Truncated GLB chunk header.');
    const length = buffer.readUInt32LE(cursor);
    const type = buffer.readUInt32LE(cursor + 4);
    cursor += 8;
    if (length % 4 || cursor + length > buffer.length) throw new Error('Invalid GLB chunk length.');
    const chunk = buffer.subarray(cursor, cursor + length);
    if (!json && type !== 0x4e4f534a) throw new Error('GLB JSON must be the first chunk.');
    if (type === 0x4e4f534a) {
      if (json) throw new Error('GLB has multiple JSON chunks.');
      json = JSON.parse(chunk.toString('utf8').replace(/[\s\0]+$/g, ''));
    } else if (type === 0x004e4942) {
      if (bin) throw new Error('GLB has multiple binary chunks.');
      bin = chunk;
    } else throw new Error(`Unsupported GLB chunk type: ${type}.`);
    cursor += length;
  }
  if (!json || json.asset?.version !== '2.0') throw new Error('A glTF 2.0 JSON asset is required.');
  return { json, bin: bin || Buffer.alloc(0) };
}

function materialInfos(material = {}) {
  return [material.pbrMetallicRoughness?.baseColorTexture, material.emissiveTexture, material.normalTexture,
    material.pbrMetallicRoughness?.metallicRoughnessTexture, material.occlusionTexture];
}

/** Restore metadata the document abstraction does not represent, using stable source resource mapping. */
export function preserveGlbMetadata(source, outputBytes) {
  const { json, bin } = parseGlb(outputBytes);
  const before = stable(json);
  function metadata(original, output) {
    if (!original || !output) return;
    for (const key of ['name', 'extras']) if (Object.hasOwn(original, key)) output[key] = clone(original[key]);
  }
  if (Object.hasOwn(source, 'extras')) json.extras = clone(source.extras);
  for (const key of ['copyright', 'extras', 'minVersion']) if (Object.hasOwn(source.asset, key)) json.asset[key] = clone(source.asset[key]);
  for (const kind of ['scenes', 'nodes', 'meshes', 'materials', 'cameras', 'images', 'buffers']) {
    for (const [index, original] of (source[kind] || []).entries()) metadata(original, json[kind]?.[index]);
  }
  for (const [meshIndex, mesh] of (source.meshes || []).entries()) for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
    const output = json.meshes[meshIndex].primitives[primitiveIndex];
    metadata(primitive, output);
    for (const [semantic, index] of Object.entries(primitive.attributes)) metadata(source.accessors[index], json.accessors[output.attributes[semantic]]);
    if (primitive.indices !== undefined && output.indices !== undefined) metadata(source.accessors[primitive.indices], json.accessors[output.indices]);
  }
  const restoreTextureTable = [...(source.textures || []), ...(source.samplers || [])].some((item) => Object.hasOwn(item, 'name') || Object.hasOwn(item, 'extras'));
  if (restoreTextureTable) {
    if ((source.images?.length || 0) !== (json.images?.length || 0)) throw new Error('Image mapping changed; source texture metadata cannot be safely restored.');
    if (source.textures) json.textures = clone(source.textures);
    if (source.samplers) json.samplers = clone(source.samplers); else delete json.samplers;
  }
  for (const [index, material] of (source.materials || []).entries()) {
    const output = json.materials[index];
    if (material.pbrMetallicRoughness && Object.hasOwn(material.pbrMetallicRoughness, 'extras')) {
      output.pbrMetallicRoughness ||= {};
      output.pbrMetallicRoughness.extras = clone(material.pbrMetallicRoughness.extras);
    }
    const sourceInfos = materialInfos(material);
    const outputInfos = materialInfos(output);
    for (let slot = 0; slot < sourceInfos.length; slot++) {
      if (!sourceInfos[slot]) continue;
      metadata(sourceInfos[slot], outputInfos[slot]);
      if (restoreTextureTable) outputInfos[slot].index = sourceInfos[slot].index;
    }
  }
  if (stable(json) === before) return outputBytes;
  const encoded = Buffer.from(JSON.stringify(json));
  const jsonPadding = Buffer.alloc((4 - encoded.length % 4) % 4, 0x20);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + encoded.length + jsonPadding.length + (bin.length ? 8 + bin.length : 0), 8);
  const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(encoded.length + jsonPadding.length); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const chunks = [header, jsonHeader, encoded, jsonPadding];
  if (bin.length) { const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(bin.length); binHeader.writeUInt32LE(0x004e4942, 4); chunks.push(binHeader, bin); }
  return Buffer.concat(chunks);
}

function textureSlots(json, materialIndex) {
  const material = json.materials?.[materialIndex];
  if (!material) return [];
  const slots = [
    ['baseColor', material.pbrMetallicRoughness?.baseColorTexture],
    ['emissive', material.emissiveTexture],
    ['normal', material.normalTexture],
    ['metallicRoughness', material.pbrMetallicRoughness?.metallicRoughnessTexture],
    ['occlusion', material.occlusionTexture],
  ];
  return slots.filter(([, info]) => info).map(([slot, info]) => ({
    slot, textureIndex: info.index, imageIndex: json.textures?.[info.index]?.source,
    alphaMode: material.alphaMode || 'OPAQUE', materialIndex,
  }));
}

function diagnose(json) {
  const diagnostics = [];
  const reject = (code, message) => diagnostics.push({ severity: 'error', code, message });
  if (json.animations?.length) reject('ANIMATION_UNSUPPORTED', 'Animation timelines are not supported.');
  if (json.skins?.length || json.nodes?.some((node) => node.skin !== undefined)) reject('SKIN_UNSUPPORTED', 'Skinned models are not supported.');
  if (json.nodes?.some((node) => node.weights) || json.meshes?.some((mesh) => mesh.weights || mesh.primitives?.some((primitive) => primitive.targets?.length))) reject('MORPH_UNSUPPORTED', 'Morph targets are not supported.');
  const foundExtensions = new Set([...(json.extensionsUsed || []), ...(json.extensionsRequired || [])]);
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.extensions) for (const name of Object.keys(value.extensions)) foundExtensions.add(name);
    for (const [key, child] of Object.entries(value)) if (key !== 'extras' && key !== 'extensions') visit(child);
  }
  visit(json);
  for (const extension of foundExtensions) if (!ALLOWED_EXTENSIONS.has(extension)) reject('EXTENSION_UNSUPPORTED', `${extension} is not supported; its contents will not be silently removed.`);
  for (const buffer of json.buffers || []) if (buffer.uri) reject('EXTERNAL_BUFFER', 'Only a self-contained binary GLB buffer is supported.');
  if ((json.bufferViews || []).some((view) => Object.hasOwn(view, 'extras') || Object.hasOwn(view, 'name'))) reject('BUFFER_VIEW_METADATA_UNSUPPORTED', 'Storage buffer-view metadata cannot be safely mapped after vertex compaction; source is not converted. Move semantic annotations to nodes, meshes, primitives or accessors.');
  if ((json.buffers?.length || 0) > 1) reject('MULTIPLE_BUFFERS', 'Only a self-contained GLB binary buffer is supported.');
  for (const image of json.images || []) {
    if (image.uri || image.bufferView === undefined) reject('EXTERNAL_IMAGE', 'All GLB images must be embedded in buffer views.');
    if (!['image/jpeg', 'image/png'].includes(image.mimeType)) reject('IMAGE_FORMAT_UNSUPPORTED', `Embedded texture format ${image.mimeType || 'unknown'} is not supported.`);
  }
  for (const mesh of json.meshes || []) for (const primitive of mesh.primitives || []) {
    if ((primitive.mode ?? 4) !== 4) reject('PRIMITIVE_MODE_UNSUPPORTED', 'Only triangle primitives are supported.');
    if (primitive.attributes?.POSITION === undefined) reject('POSITION_MISSING', 'Every triangle primitive must provide POSITION.');
    for (const semantic of Object.keys(primitive.attributes || {})) if (/^(JOINTS|WEIGHTS)_/.test(semantic)) reject('SKIN_ATTRIBUTE_UNSUPPORTED', `Skin attribute ${semantic} is not supported.`);
  }
  if (!json.meshes?.length) reject('EMPTY_MODEL', 'The GLB does not contain triangle meshes.');
  return diagnostics;
}

async function validateBytes(bytes) {
  const result = await validator.validateBytes(new Uint8Array(bytes), { format: 'glb', maxIssues: 200, writeTimestamp: false });
  return { valid: result.issues.numErrors === 0, errors: result.issues.numErrors, warnings: result.issues.numWarnings,
    messages: result.issues.messages, version: validator.version() };
}

export async function inspectGlb(filePath) {
  const bytes = await fs.readFile(filePath);
  let parsed;
  try { parsed = parseGlb(bytes); } catch (error) {
    return { type: 'glb', bytes: bytes.length, hash: hash(bytes), supported: false, diagnostics: [{ severity: 'error', code: 'INVALID_GLB', message: error.message }], objects: [], geometryGroups: [], textureGroups: [] };
  }
  const { json, bin } = parsed;
  const diagnostics = diagnose(json);
  const geometryGroups = [];
  for (const [meshIndex, mesh] of (json.meshes || []).entries()) for (const [primitiveIndex, primitive] of (mesh.primitives || []).entries()) {
    const position = json.accessors?.[primitive.attributes?.POSITION];
    geometryGroups.push({ id: `mesh-${meshIndex}-primitive-${primitiveIndex}`, meshIndex, primitiveIndex,
      name: `${mesh.name || `Mesh ${meshIndex + 1}`} / ${primitiveIndex + 1}`, vertices: position?.count || 0,
      triangles: Math.floor((json.accessors?.[primitive.indices]?.count || position?.count || 0) / 3),
      accessors: [...new Set([...Object.values(primitive.attributes || {}), primitive.indices].filter((index) => index !== undefined))],
      materialIndex: primitive.material ?? null,
      textureGroups: [...new Set(textureSlots(json, primitive.material).map((slot) => `image-${slot.imageIndex}`))],
      objectIds: (json.nodes || []).flatMap((node, index) => node.mesh === meshIndex ? [`node-${index}`] : []),
    });
  }
  const textureGroups = [];
  for (const [index, image] of (json.images || []).entries()) {
    const slots = (json.materials || []).flatMap((_, materialIndex) => textureSlots(json, materialIndex)).filter((slot) => slot.imageIndex === index);
    const bufferView = json.bufferViews?.[image.bufferView];
    let metadata = {};
    if (bufferView && !diagnostics.some((item) => item.code === 'EXTERNAL_IMAGE')) {
      try { metadata = await sharp(bin.subarray(bufferView.byteOffset || 0, (bufferView.byteOffset || 0) + bufferView.byteLength), { limitInputPixels: 64_000_000 }).metadata(); }
      catch (error) { diagnostics.push({ severity: 'error', code: 'INVALID_TEXTURE', message: `Image ${index}: ${error.message}` }); }
    }
    const colorOnly = slots.length > 0 && slots.every((slot) => slot.slot === 'baseColor' || slot.slot === 'emissive');
    const alphaConservative = Boolean(metadata.hasAlpha) || slots.some((slot) => slot.alphaMode !== 'OPAQUE');
    textureGroups.push({ id: `image-${index}`, index, name: image.name || `Image ${index + 1}`, mimeType: image.mimeType,
      width: metadata.width, height: metadata.height, bytes: bufferView?.byteLength || 0, hasAlpha: Boolean(metadata.hasAlpha),
      slots: [...new Set(slots.map((slot) => slot.slot))], optimizable: colorOnly && !alphaConservative,
      reason: !colorOnly ? 'Data or unused texture: original bytes retained.' : alphaConservative ? 'Transparency or alpha material: original bytes retained.' : 'Opaque color texture may be resized and JPEG encoded.',
      objectIds: [...new Set(geometryGroups.filter((group) => group.textureGroups.includes(`image-${index}`)).flatMap((group) => group.objectIds))] });
  }
  const objects = (json.nodes || []).map((node, index) => ({ id: `node-${index}`, index,
    name: node.name || `Node ${index + 1}`, meshId: node.mesh === undefined ? null : `mesh-${node.mesh}`, children: (node.children || []).map((i) => `node-${i}`),
    geometryGroups: geometryGroups.filter((group) => group.meshIndex === node.mesh).map((group) => group.id),
    textureGroups: [...new Set(geometryGroups.filter((group) => group.meshIndex === node.mesh).flatMap((group) => group.textureGroups))] }));
  const validation = await validateBytes(bytes);
  if (!validation.valid) diagnostics.push({ severity: 'error', code: 'VALIDATOR_ERRORS', message: `glTF Validator found ${validation.errors} errors.`, details: validation.messages.filter((message) => message.severity === 0) });
  return { type: 'glb', bytes: bytes.length, hash: hash(bytes), supported: !diagnostics.some((item) => item.severity === 'error'),
    diagnostics, validation, objects, geometryGroups, textureGroups, meshCount: json.meshes?.length || 0,
    primitiveCount: geometryGroups.length, triangleCount: geometryGroups.reduce((sum, group) => sum + group.triangles, 0),
    extensions: json.extensionsUsed || [], compatibility: 'Core glTF 2.0 with optional KHR_texture_transform; no external decoder.', version: GLB_PIPELINE_VERSION };
}

/** A shared accessor locks every primitive that uses it, without splitting the source. */
export function resolveGlbProtection(capabilities, constraints = {}, usages = []) {
  const requested = new Set([...(constraints.lockedObjects || constraints.lockObjects || []),
    ...usages.flatMap((usage) => usage.lockedObjects || usage.protection?.lockedObjects || [])].map((value) => typeof value === 'number' ? `node-${value}` : value));
  const allLocked = constraints.lockOriginal === true || constraints.mode === 'lock' || constraints.mode === 'lock-original';
  if (allLocked) for (const object of capabilities.objects) requested.add(object.id);
  const descendants = [...requested];
  while (descendants.length) {
    const current = capabilities.objects.find((object) => object.id === descendants.pop());
    for (const child of current?.children || []) if (!requested.has(child)) { requested.add(child); descendants.push(child); }
  }
  const geometry = new Set(capabilities.geometryGroups.filter((group) => group.objectIds.some((id) => requested.has(id))).map((group) => group.id));
  const textures = new Set(capabilities.textureGroups.filter((group) => group.objectIds.some((id) => requested.has(id))).map((group) => group.id));
  let changed = true;
  while (changed) {
    changed = false;
    const accessors = new Set(capabilities.geometryGroups.filter((group) => geometry.has(group.id)).flatMap((group) => group.accessors));
    for (const group of capabilities.geometryGroups) if (!geometry.has(group.id) && group.accessors.some((index) => accessors.has(index))) { geometry.add(group.id); changed = true; }
  }
  const affectedObjects = capabilities.objects.filter((object) => object.geometryGroups.some((id) => geometry.has(id)) || object.textureGroups.some((id) => textures.has(id))).map((object) => object.id);
  const unknownObjects = [...requested].filter((id) => !capabilities.objects.some((object) => object.id === id));
  if (unknownObjects.length) throw new Error(`Unknown protected object IDs: ${unknownObjects.join(', ')}.`);
  return { allLocked, requestedObjects: [...requested], lockedGeometry: [...geometry], lockedTextures: [...textures], affectedObjects };
}

function accessorRecord(accessor, includeData = true) {
  return { type: accessor.getType(), componentType: accessor.getComponentType(), normalized: accessor.getNormalized(),
    name: accessor.getName(), extras: accessor.getExtras(), ...(includeData ? { count: accessor.getCount(), data: hash(Buffer.from(accessor.getArray().buffer, accessor.getArray().byteOffset, accessor.getArray().byteLength)) } : {}) };
}

async function semanticSnapshot(io, document, protection) {
  const { json } = await io.writeJSON(document);
  const root = document.getRoot();
  const meshes = root.listMeshes().map((mesh, meshIndex) => ({ name: mesh.getName(), extras: mesh.getExtras(), primitives: mesh.listPrimitives().map((primitive, primitiveIndex) => {
    const locked = protection.lockedGeometry.includes(`mesh-${meshIndex}-primitive-${primitiveIndex}`);
    return { mode: primitive.getMode(), material: root.listMaterials().indexOf(primitive.getMaterial()), extras: primitive.getExtras(),
      attributes: Object.fromEntries(primitive.listSemantics().sort().map((semantic) => [semantic, accessorRecord(primitive.getAttribute(semantic), locked)])),
      ...(locked ? { indices: primitive.getIndices() ? accessorRecord(primitive.getIndices()) : null } : {}) };
  }) }));
  return canonical({ rootExtras: root.getExtras(), scenes: json.scenes || [], scene: json.scene ?? null, nodes: json.nodes || [],
    cameras: json.cameras || [], materials: json.materials || [], samplers: json.samplers || [], textures: json.textures || [], meshes,
    images: root.listTextures().map((texture, index) => ({ name: texture.getName(), extras: texture.getExtras(),
      ...(protection.lockedTextures.includes(`image-${index}`) ? { mimeType: texture.getMimeType(), imageHash: hash(texture.getImage()) } : {}) })),
    extensionsUsed: json.extensionsUsed || [], extensionsRequired: json.extensionsRequired || [] });
}

function cloneAccessor(document, source, array) {
  const result = document.createAccessor(source?.getName() || '').setType(source?.getType() || 'SCALAR').setArray(array);
  if (source) result.setNormalized(source.getNormalized()).setExtras(clone(source.getExtras())).setBuffer(source.getBuffer());
  else result.setBuffer(document.getRoot().listBuffers()[0]);
  return result;
}

/** Uses only public meshoptimizer APIs. Every rewritten attribute gets a private accessor. */
export function simplifyPrimitive(document, primitive, ratio, error = 0.08) {
  const position = primitive.getAttribute('POSITION');
  const indexAccessor = primitive.getIndices();
  const indices = indexAccessor ? new Uint32Array(indexAccessor.getArray()) : Uint32Array.from({ length: position.getCount() }, (_, index) => index);
  if (ratio >= 1 || indices.length <= 6) return { before: indices.length / 3, after: indices.length / 3, error: 0 };
  const positions = new Float32Array(position.getCount() * 3);
  const element = [];
  for (let index = 0; index < position.getCount(); index++) { position.getElement(index, element); positions.set(element, index * 3); }
  const target = Math.max(3, Math.floor(indices.length * ratio / 3) * 3);
  const attributes = primitive.listSemantics().filter((semantic) => /^(NORMAL|TEXCOORD_0|COLOR_0)$/.test(semantic));
  const stride = attributes.reduce((sum, semantic) => sum + primitive.getAttribute(semantic).getElementSize(), 0);
  const attributeArray = new Float32Array(position.getCount() * stride);
  const weights = [];
  let offset = 0;
  for (const semantic of attributes) {
    const accessor = primitive.getAttribute(semantic);
    element.length = accessor.getElementSize();
    for (let index = 0; index < accessor.getCount(); index++) { accessor.getElement(index, element); attributeArray.set(element, index * stride + offset); }
    weights.push(...Array(accessor.getElementSize()).fill(semantic === 'NORMAL' ? 0.25 : 1));
    offset += accessor.getElementSize();
  }
  const [result, measuredError] = stride ? MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attributeArray, stride, weights, null, target, error, ['LockBorder'])
    : MeshoptSimplifier.simplify(indices, positions, 3, target, error, ['LockBorder']);
  if (!result.length) throw new Error('Simplification would remove a complete primitive.');
  if (result.length >= indices.length) return { before: indices.length / 3, after: indices.length / 3, error: measuredError };
  const remap = new Map();
  const originalVertices = [];
  const compact = new Uint32Array(result.length);
  for (let index = 0; index < result.length; index++) {
    const vertex = result[index];
    if (!remap.has(vertex)) { remap.set(vertex, remap.size); originalVertices.push(vertex); }
    compact[index] = remap.get(vertex);
  }
  const replaced = [];
  for (const semantic of primitive.listSemantics()) {
    const accessor = primitive.getAttribute(semantic);
    const source = accessor.getArray();
    const size = accessor.getElementSize();
    const array = new source.constructor(originalVertices.length * size);
    originalVertices.forEach((vertex, index) => array.set(source.subarray(vertex * size, vertex * size + size), index * size));
    primitive.setAttribute(semantic, cloneAccessor(document, accessor, array));
    replaced.push(accessor);
  }
  primitive.setIndices(cloneAccessor(document, indexAccessor, originalVertices.length <= 65534 ? new Uint16Array(compact) : compact));
  if (indexAccessor) replaced.push(indexAccessor);
  for (const accessor of new Set(replaced)) if (accessor.listParents().every((parent) => parent.propertyType === 'Root')) accessor.dispose();
  return { before: indices.length / 3, after: result.length / 3, error: measuredError };
}

function randomGenerator(seed) {
  let state = (Number(seed) || 1) >>> 0;
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let value = state; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
  next.state = () => state;
  next.restore = (value) => { state = value >>> 0; };
  return next;
}

function features(vector) {
  const x = vector.map((value) => value / 4);
  const result = [1, ...x, ...x.map((value) => value * value)];
  for (let index = 0; index < Math.min(x.length - 1, 12); index++) result.push(x[index] * x[index + 1]);
  return result;
}
function fitRidge(records, target) {
  const rows = records.map((record) => features(record.vector));
  const length = rows[0].length;
  const matrix = Array.from({ length }, (_, row) => Array.from({ length: length + 1 }, (_, col) => col === length ? rows.reduce((sum, x, index) => sum + x[row] * target(records[index]), 0) : rows.reduce((sum, x) => sum + x[row] * x[col], 0) + (row === col ? 0.05 : 0)));
  for (let pivot = 0; pivot < length; pivot++) {
    let best = pivot;
    for (let row = pivot + 1; row < length; row++) if (Math.abs(matrix[row][pivot]) > Math.abs(matrix[best][pivot])) best = row;
    [matrix[pivot], matrix[best]] = [matrix[best], matrix[pivot]];
    const divisor = matrix[pivot][pivot] || 1e-12;
    for (let col = pivot; col <= length; col++) matrix[pivot][col] /= divisor;
    for (let row = 0; row < length; row++) if (row !== pivot) { const scale = matrix[row][pivot]; for (let col = pivot; col <= length; col++) matrix[row][col] -= scale * matrix[pivot][col]; }
  }
  const weights = matrix.map((row) => row[length]);
  return (vector) => features(vector).reduce((sum, value, index) => sum + value * weights[index], 0);
}

function proposeVector({ variables, records, seen, random, method, useSurrogate, sourceBytes }) {
  const count = variables.length;
  for (let level = 1; level <= 4; level++) { const vector = Array(count).fill(level); if (!seen.has(stable(vector))) return { vector, phase: 'uniform-initialization' }; }
  if (method === 'uniform') return null;
  const fresh = (vector) => !seen.has(stable(vector));
  const measured = records.filter((record) => record.valid && Number.isFinite(record.loss));
  const objective = (record, weight) => record.loss + weight * record.bytes / sourceBytes;
  const weight = 0.025 + random() * 0.65;
  const pool = [];
  if (method === 'greedy') {
    const anchors = [...measured].sort((a, b) => objective(a, 0.2) - objective(b, 0.2));
    for (const anchor of anchors) {
      for (let dimension = 0; dimension < count; dimension++) {
        const vector = [...anchor.vector];
        if (vector[dimension] < 4) { vector[dimension]++; if (fresh(vector)) pool.push(vector); }
      }
      if (pool.length) return { vector: pool[0], phase: 'measured-greedy-neighbor' };
    }
  }
  for (let attempt = 0; attempt < 160; attempt++) {
    let vector;
    if (method === 'random' || !measured.length || random() < 0.2) vector = Array.from({ length: count }, () => Math.floor(random() * 5));
    else {
      const tournament = () => {
        const a = measured[Math.floor(random() * measured.length)];
        const b = measured[Math.floor(random() * measured.length)];
        return objective(a, weight) < objective(b, weight) ? a : b;
      };
      const left = tournament();
      const right = tournament();
      vector = left.vector.map((value, index) => random() < 0.3 ? right.vector[index] : value);
      const dimension = Math.floor(random() * count);
      vector[dimension] = Math.max(0, Math.min(4, vector[dimension] + (random() < 0.5 ? -1 : 1)));
      if (random() < 0.25) vector[Math.floor(random() * count)] = Math.floor(random() * 5);
    }
    if (fresh(vector) && !pool.some((other) => stable(other) === stable(vector))) pool.push(vector);
    if (method === 'random' && pool.length) break;
    if (pool.length >= 32) break;
  }
  if (!pool.length) return null;
  if (method !== 'evolutionary' || !useSurrogate || measured.length < 5) return { vector: pool[0], phase: method === 'random' ? 'random' : 'evolution-mutation' };
  const trainingStart = performance.now();
  const lossPredictor = fitRidge(measured, (record) => record.loss);
  const bytesPredictor = fitRidge(measured, (record) => record.bytes / sourceBytes);
  const score = (vector) => {
    const distance = Math.min(...measured.map((record) => vector.reduce((sum, value, index) => sum + (value - record.vector[index]) ** 2, 0) / Math.max(1, count * 16)));
    return Math.max(0, lossPredictor(vector)) + weight * Math.max(0, bytesPredictor(vector)) - 0.015 * Math.sqrt(distance);
  };
  pool.sort((a, b) => score(a) - score(b));
  return { vector: pool[0], phase: 'evolution-surrogate-proposal', trainingMs: performance.now() - trainingStart,
    surrogate: { type: 'ridge-polynomial', observations: measured.length, poolSize: pool.length, predictedLoss: lossPredictor(pool[0]), predictedBytes: bytesPredictor(pool[0]) * sourceBytes,
      note: 'Predictions rank the next physical evaluation only; they never become candidate quality scores.' } };
}

export async function generateGlbCandidates({ sourcePath, outputDir, asset = {}, settings = {}, evaluate, onCandidate, onObservation, signal, observations = [] }) {
  if (typeof evaluate !== 'function') throw new Error('A file-based GLB renderer evaluator is required.');
  const started = performance.now();
  const capabilities = asset.capabilities?.geometryGroups ? asset.capabilities : await inspectGlb(sourcePath);
  if (!capabilities.supported) throw new Error(`Unsupported GLB: ${capabilities.diagnostics.filter((item) => item.severity === 'error').map((item) => item.message).join(' ')}`);
  const originalBytes = await fs.readFile(sourcePath);
  const sourceJson = parseGlb(originalBytes).json;
  if (hash(originalBytes) !== capabilities.hash) throw new Error('GLB source hash changed after inspection.');
  const protection = resolveGlbProtection(capabilities, asset.constraints || asset.protection || {}, asset.usages || []);
  const variables = [
    ...capabilities.geometryGroups.filter((group) => !protection.lockedGeometry.includes(group.id)).map((group) => ({ id: group.id, kind: 'geometry', meshIndex: group.meshIndex, primitiveIndex: group.primitiveIndex })),
    ...capabilities.textureGroups.filter((group) => group.optimizable && !protection.lockedTextures.includes(group.id)).map((group) => ({ id: group.id, kind: 'texture', index: group.index })),
  ];
  const lockedTextures = [...new Set([...protection.lockedTextures, ...capabilities.textureGroups.filter((group) => !group.optimizable).map((group) => group.id)])];
  const semanticProtection = { ...protection, lockedTextures };
  const io = createIO();
  const baselineDocument = await io.readBinary(new Uint8Array(originalBytes));
  const baseline = stable(await semanticSnapshot(io, baselineDocument, semanticProtection));
  const sourceImages = baselineDocument.getRoot().listTextures().map((texture) => ({ bytes: Buffer.from(texture.getImage()), mimeType: texture.getMimeType() }));
  const method = settings.method || settings.searchMethod || 'evolutionary';
  if (!['evolutionary', 'uniform', 'random', 'greedy'].includes(method)) throw new Error(`Unknown GLB search method: ${method}.`);
  const maxEvaluations = Math.max(1, Math.min(128, Math.floor(settings.maxEvaluations ?? settings.glbEvaluations ?? 12)));
  const seed = settings.seed ?? 1;
  const useSurrogate = settings.useSurrogate !== false;
  const random = randomGenerator(seed);
  const candidates = [];
  const records = [];
  const seen = new Set();
  await fs.mkdir(outputDir, { recursive: true });
  await MeshoptSimplifier.ready;
  const generationKey = hash(stable({ source: capabilities.hash, variables, protection, settings: { method, seed, useSurrogate, error: settings.simplifyError ?? 0.08, evaluationKey: settings.evaluationKey || null }, version: GLB_PIPELINE_VERSION, usages: asset.usages || [] }));
  const report = async (event) => { if (onObservation) await onObservation({ ...event, elapsedMs: performance.now() - started, generationKey, method, seed }); };
  await report({ event: 'initialization', costMs: performance.now() - started, variables, protection, maxEvaluations, scoring: 'Measured evaluator loss; ridge predictions only choose the next evaluation.' });

  const history = [...observations, ...(settings.resumeObservations || [])].filter((observation) => observation.generationKey === generationKey);
  const proposals = new Map();
  const completions = new Map();
  for (const observation of history) {
    if (observation.event === 'proposal' && observation.attempt) proposals.set(observation.attempt, observation);
    if (observation.event === 'candidate' && observation.attempt) completions.set(observation.attempt, observation);
  }
  const pendingRetries = [];
  // Existing observations are accepted only with the same generation key and verified files.
  for (const observation of completions.size ? [...completions.values()].sort((a, b) => a.attempt - b.attempt) : history) {
    if (observation.event !== 'candidate' || observation.generationKey !== generationKey || !observation.candidate) continue;
    const candidate = observation.candidate;
    try {
      if (candidate.valid) {
        const data = await fs.readFile(candidate.file);
        if (hash(data) !== candidate.hash || data.length !== candidate.bytes) throw new Error('Archive output hash mismatch.');
      }
      if (candidates.some((item) => item.id === candidate.id)) continue;
      candidates.push(candidate);
      seen.add(stable(observation.vector));
      records.push({ vector: observation.vector, loss: candidate.metrics?.loss, bytes: candidate.bytes, valid: candidate.valid });
      if (observation.randomState !== undefined) random.restore(observation.randomState);
      await report({ event: 'resume-cache-hit', candidateId: candidate.id, logicalEvaluationAlreadyCounted: true, physicalCostMs: 0 });
    } catch {
      pendingRetries.push({ vector: observation.vector, phase: 'retry-missing-output', attempt: observation.attempt });
    }
  }
  for (const [attempt, proposal] of proposals) if (!completions.has(attempt)) pendingRetries.push({ vector: proposal.vector, phase: 'retry-interrupted-proposal', attempt });
  const lastProposal = [...proposals.values()].sort((a, b) => b.attempt - a.attempt)[0];
  if (lastProposal?.randomState !== undefined) random.restore(lastProposal.randomState);
  let attempts = Math.max(candidates.length, 0, ...proposals.keys(), ...completions.keys());
  while (attempts < maxEvaluations || pendingRetries.length) {
    checkCancelled(signal);
    const retry = pendingRetries.shift();
    const proposal = retry || (!seen.has(stable(Array(variables.length).fill(0))) ? { vector: Array(variables.length).fill(0), phase: 'original' }
      : variables.length && !protection.allLocked ? proposeVector({ variables, records, seen, random, method, useSurrogate, sourceBytes: originalBytes.length }) : null);
    if (!proposal) break;
    const { vector } = proposal;
    seen.add(stable(vector));
    if (!retry) attempts++;
    const logicalAttempt = retry?.attempt || attempts;
    const params = { version: GLB_PIPELINE_VERSION, geometry: {}, textures: {}, method, sourceHash: capabilities.hash };
    variables.forEach((variable, index) => { params[variable.kind === 'geometry' ? 'geometry' : 'textures'][variable.id] = vector[index]; });
    const original = vector.every((level) => level === 0);
    params.original = original;
    const id = original ? 'original' : `glb-${hash(stable({ geometry: params.geometry, textures: params.textures, source: capabilities.hash })).slice(0, 14)}`;
    const destination = path.resolve(outputDir, `${id}.glb`);
    const timings = { transformMs: 0, encodeMs: 0, validationMs: 0, evaluationMs: 0, surrogateTrainingMs: proposal.trainingMs || 0 };
    if (retry) await report({ event: 'candidate-retry', candidateId: id, attempt: logicalAttempt, reason: retry.phase, logicalEvaluationAlreadyCounted: true });
    await report({ event: 'proposal', candidateId: id, attempt: logicalAttempt, vector, phase: proposal.phase, surrogate: proposal.surrogate, trainingMs: proposal.trainingMs || 0, randomState: random.state() });
    const candidateStarted = performance.now();
    let candidate;
    try {
      let data;
      const geometryChanges = [];
      const textureChanges = [];
      if (original) data = originalBytes;
      else {
        const transformStarted = performance.now();
        const document = await io.readBinary(new Uint8Array(originalBytes));
        for (const [index, variable] of variables.entries()) {
          checkCancelled(signal);
          const level = GLB_LEVELS[vector[index]];
          if (!vector[index]) continue;
          if (variable.kind === 'geometry') {
            const primitive = document.getRoot().listMeshes()[variable.meshIndex].listPrimitives()[variable.primitiveIndex];
            geometryChanges.push({ group: variable.id, requestedRatio: level.ratio, ...simplifyPrimitive(document, primitive, level.ratio, settings.simplifyError ?? 0.08) });
          } else {
            const texture = document.getRoot().listTextures()[variable.index];
            const source = sourceImages[variable.index];
            const metadata = await sharp(source.bytes, { limitInputPixels: 64_000_000 }).metadata();
            const width = Math.max(1, Math.round(metadata.width * level.textureScale));
            const height = Math.max(1, Math.round(metadata.height * level.textureScale));
            const encoded = await sharp(source.bytes, { limitInputPixels: 64_000_000 }).toColourspace('srgb').resize(width, height, { fit: 'fill' }).jpeg({ quality: level.quality, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
            await sharp(encoded).raw().toBuffer();
            texture.setImage(encoded).setMimeType('image/jpeg');
            textureChanges.push({ group: variable.id, width, height, quality: level.quality, beforeBytes: source.bytes.length, afterBytes: encoded.length });
          }
        }
        timings.transformMs = performance.now() - transformStarted;
        const encodeStarted = performance.now();
        data = preserveGlbMetadata(sourceJson, Buffer.from(await io.writeBinary(document)));
        timings.encodeMs = performance.now() - encodeStarted;
      }
      checkCancelled(signal);
      await fs.writeFile(`${destination}.partial`, data);
      await fs.rename(`${destination}.partial`, destination);
      const written = await fs.readFile(destination);
      const validationStarted = performance.now();
      const validation = await validateBytes(written);
      if (!validation.valid) throw new Error(`Candidate glTF validation failed: ${validation.messages.filter((message) => message.severity === 0).map((message) => message.message).join('; ')}`);
      const decoded = await io.readBinary(new Uint8Array(written));
      const semantics = stable(await semanticSnapshot(io, decoded, semanticProtection));
      if (semantics !== baseline) throw new Error('Candidate failed hierarchy, material, attribute, or locked-resource semantic preservation.');
      timings.validationMs = performance.now() - validationStarted;
      checkCancelled(signal);
      const evaluateStarted = performance.now();
      const metrics = await evaluate(destination, params);
      timings.evaluationMs = performance.now() - evaluateStarted;
      if (!Number.isFinite(metrics?.loss) || metrics.loss < 0 || !Array.isArray(metrics.uses)) throw new Error('Renderer must return finite non-negative loss and per-usage measurements.');
      if (metrics.valid === false) throw new Error(`Renderer hard validity check failed: ${stable(metrics.diagnostics || metrics.uses)}.`);
      candidate = { id, file: destination, bytes: written.length, hash: hash(written), params, valid: true, metrics, costMs: performance.now() - candidateStarted,
        diagnostics: { validation, semanticPreservation: true, protection, geometryChanges, textureChanges, timings, generationKey, evaluation: 'Reloaded file with original fixed viewing conditions.' } };
    } catch (error) {
      if (error.name === 'AbortError') { await report({ event: 'cancelled-candidate', candidateId: id, attempt: logicalAttempt, vector, costMs: performance.now() - candidateStarted, randomState: random.state() }); throw error; }
      let failedBytes = Buffer.alloc(0);
      try { failedBytes = await fs.readFile(destination); } catch { /* Encoding may fail before a file exists. */ }
      candidate = { id, file: destination, bytes: failedBytes.length, hash: hash(failedBytes), params, valid: false, metrics: null,
        costMs: performance.now() - candidateStarted, diagnostics: { error: error.message, timings, generationKey } };
    }
    candidates.push(candidate);
    records.push({ vector, valid: candidate.valid, loss: candidate.metrics?.loss, bytes: candidate.bytes });
    await report({ event: 'candidate', candidate, vector, randomState: random.state(), attempt: logicalAttempt, costMs: candidate.costMs, phase: proposal.phase });
    if (onCandidate) await onCandidate(candidate);
  }
  await report({ event: 'search-complete', attempts, validCandidates: candidates.filter((candidate) => candidate.valid).length,
    stopped: signal?.aborted ? 'cancelled' : attempts >= maxEvaluations ? 'evaluation-limit' : 'proposal-space-exhausted',
    retained: 'All measured candidates are retained; the project allocator may compute a score-specific Pareto frontier.', totalMs: performance.now() - started });
  return candidates;
}

export async function benchmarkGlbSearch(options) {
  const results = [];
  const methods = options.methods || ['uniform', 'random', 'greedy', 'evolutionary'];
  const seeds = options.seeds || [1, 7, 19];
  for (const seed of seeds) for (const method of methods) {
    checkCancelled(options.signal);
    const observations = [];
    const started = performance.now();
    const candidates = await generateGlbCandidates({ ...options, outputDir: path.join(options.outputDir, `${method}-seed-${seed}`),
      settings: { ...options.settings, method, seed }, observations: [], onCandidate: undefined,
      onObservation: async (event) => { observations.push(event); if (options.onObservation) await options.onObservation(event); } });
    results.push({ method, seed, logicalEvaluations: candidates.length, physicalMs: performance.now() - started,
      candidates: candidates.map(({ id, bytes, valid, metrics, costMs }) => ({ id, bytes, valid, loss: metrics?.loss ?? null, costMs })), observations });
  }
  return { version: GLB_PIPELINE_VERSION, initialization: 'Original plus up to four uniform levels; the same defined vectors are independently measured in each run.',
    cache: 'No observations shared across methods; each receives an independent archive and physical evaluation budget.', results };
}
