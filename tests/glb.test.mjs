import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRTextureTransform } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { inspectGlb, parseGlb, preserveGlbMetadata, resolveGlbProtection, generateGlbCandidates } from '../src/glb.mjs';

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(directory) {
  const document = new Document();
  const buffer = document.createBuffer();
  document.getRoot().setExtras({ project: 'Shared geometry fixture' });
  const color = document.createTexture('Shared color').setImage(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#d59d35' } }).png().toBuffer()).setMimeType('image/png');
  const normal = document.createTexture('Normal data').setImage(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#8080ff' } }).png().toBuffer()).setMimeType('image/png');
  const material = document.createMaterial('PBR material').setBaseColorTexture(color).setNormalTexture(normal).setExtras({ role: 'protected appearance' });
  const extension = document.createExtension(KHRTextureTransform);
  material.getBaseColorTextureInfo().setTexCoord(0).setWrapS(33648).setExtension('KHR_texture_transform', extension.createTransform().setOffset([0.1, 0.2]).setScale([0.8, 0.7]));
  function grid() {
    const positions = [], normals = [], tangents = [], uvs = [], colors = [], indices = [];
    const n = 14;
    for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
      positions.push(x / n, y / n, 0.03 * Math.sin(x / n * 6) * Math.sin(y / n * 6));
      normals.push(0, 0, 1); tangents.push(1, 0, 0, 1); uvs.push(x / n, y / n); colors.push(1, x / n, y / n, 1);
    }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const a = y * (n + 1) + x; indices.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1); }
    const accessor = (name, type, data) => document.createAccessor(name).setType(type).setBuffer(buffer).setArray(new Float32Array(data)).setExtras({ attribute: name });
    return { POSITION: accessor('Positions', 'VEC3', positions), NORMAL: accessor('Normals', 'VEC3', normals), TANGENT: accessor('Tangents', 'VEC4', tangents),
      TEXCOORD_0: accessor('UV set', 'VEC2', uvs), COLOR_0: accessor('Colors', 'VEC4', colors),
      indices: document.createAccessor('Topology').setType('SCALAR').setBuffer(buffer).setArray(new Uint16Array(indices)) };
  }
  const shared = grid();
  const primitive = (resources) => {
    const result = document.createPrimitive().setMaterial(material).setIndices(resources.indices).setExtras({ part: 'surface' });
    for (const [semantic, accessor] of Object.entries(resources)) if (semantic !== 'indices') result.setAttribute(semantic, accessor);
    return result;
  };
  const sharedMesh = document.createMesh('Repeated name').setExtras({ mesh: 1 }).addPrimitive(primitive(shared)).addPrimitive(primitive(shared));
  const sharedAccessorMesh = document.createMesh('Repeated name').addPrimitive(primitive(shared));
  const separateMesh = document.createMesh('Independent').addPrimitive(primitive(grid()));
  const parent = document.createNode('Parent').setTranslation([1, 2, 3]).setExtras({ group: true });
  const locked = document.createNode('Repeated name').setMesh(sharedMesh).setScale([2, 2, 2]);
  parent.addChild(locked);
  const instance = document.createNode('Repeated name').setMesh(sharedMesh).setTranslation([2, 0, 0]);
  const accessorInstance = document.createNode('Accessor instance').setMesh(sharedAccessorMesh).setTranslation([4, 0, 0]);
  const separate = document.createNode('Independent').setMesh(separateMesh).setTranslation([6, 0, 0]);
  document.createScene('Scene').addChild(parent).addChild(instance).addChild(accessorInstance).addChild(separate);
  const file = path.join(directory, 'shared.glb');
  await new NodeIO().registerExtensions([KHRTextureTransform]).write(file, document);
  return { file, document };
}

test('raw preflight rejects invalid headers and unsupported animation before conversion', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assetfit-glb-invalid-'));
  try {
    const file = path.join(directory, 'invalid.glb');
    await fs.writeFile(file, 'not a GLB');
    assert.equal((await inspectGlb(file)).supported, false);
    assert.throws(() => parseGlb(Buffer.alloc(20)), /header/);
    const { file: source } = await fixture(directory);
    const original = parseGlb(await fs.readFile(source));
    original.json.extensionsUsed.push('KHR_materials_transmission');
    original.json.animations = [{ channels: [], samplers: [] }];
    const json = Buffer.from(JSON.stringify(original.json));
    const padding = Buffer.alloc((4 - json.length % 4) % 4, 0x20);
    const jsonChunk = Buffer.alloc(8); jsonChunk.writeUInt32LE(json.length + padding.length); jsonChunk.writeUInt32LE(0x4e4f534a, 4);
    const binChunk = Buffer.alloc(8); binChunk.writeUInt32LE(original.bin.length); binChunk.writeUInt32LE(0x004e4942, 4);
    const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + padding.length + 8 + original.bin.length, 8);
    await fs.writeFile(file, Buffer.concat([header, jsonChunk, json, padding, binChunk, original.bin]));
    const capabilities = await inspectGlb(file);
    assert.equal(capabilities.supported, false);
    assert.ok(capabilities.diagnostics.some((diagnostic) => diagnostic.code === 'EXTENSION_UNSUPPORTED'));
    assert.ok(capabilities.diagnostics.some((diagnostic) => diagnostic.code === 'ANIMATION_UNSUPPORTED'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('shared nodes, primitives and accessors propagate locks while keeping independent geometry editable', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assetfit-glb-shared-'));
  try {
    const { file } = await fixture(directory);
    const capabilities = await inspectGlb(file);
    assert.equal(capabilities.supported, true);
    assert.equal(capabilities.geometryGroups.length, 4);
    assert.equal(capabilities.geometryGroups[0].objectIds.length, 2);
    const lockedNode = capabilities.objects.find((object) => object.meshId === 'mesh-0');
    const protection = resolveGlbProtection(capabilities, { lockedObjects: [lockedNode.id] });
    assert.deepEqual(protection.lockedGeometry, ['mesh-0-primitive-0', 'mesh-0-primitive-1', 'mesh-1-primitive-0']);
    assert.deepEqual(protection.lockedTextures.sort(), ['image-0', 'image-1']);
    assert.equal(protection.affectedObjects.length, 4);
    const observedFiles = [];
    const candidates = await generateGlbCandidates({ sourcePath: file, outputDir: path.join(directory, 'candidates'),
      asset: { capabilities, constraints: { lockedObjects: [lockedNode.id] } }, settings: { maxEvaluations: 5 },
      evaluate: async (candidateFile) => { const inspection = await inspectGlb(candidateFile); assert.equal(inspection.validation.valid, true); observedFiles.push(candidateFile); return { loss: 0, uses: [] }; } });
    assert.equal(observedFiles.length, 5);
    assert.ok(candidates.every((candidate) => candidate.valid), JSON.stringify(candidates.map((candidate) => candidate.diagnostics)));
    assert.ok(candidates.some((candidate) => candidate.bytes < candidates[0].bytes));
    assert.equal(candidates[0].hash, digest(await fs.readFile(file)));
    for (const candidate of candidates.slice(1)) {
      assert.equal(candidate.diagnostics.semanticPreservation, true);
      assert.deepEqual(Object.keys(candidate.params.geometry), ['mesh-2-primitive-0']);
      assert.deepEqual(candidate.params.textures, {});
      assert.equal(candidate.diagnostics.textureChanges.length, 0);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('original lock returns byte-identical source and cancellation does not fabricate a candidate', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assetfit-glb-lock-'));
  try {
    const { file } = await fixture(directory);
    const candidates = await generateGlbCandidates({ sourcePath: file, outputDir: path.join(directory, 'locked'), asset: { constraints: { lockOriginal: true } },
      evaluate: async () => ({ loss: 0, uses: [] }) });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].hash, digest(await fs.readFile(file)));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(generateGlbCandidates({ sourcePath: file, outputDir: path.join(directory, 'cancelled'), signal: controller.signal,
      evaluate: async () => ({ loss: 0, uses: [] }) }), { name: 'AbortError' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('resumed measured search preserves the proposal sequence and logical evaluation limit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assetfit-glb-resume-'));
  try {
    const { file } = await fixture(directory);
    const observations = [];
    const evaluate = async (candidateFile) => ({ loss: (await fs.stat(candidateFile)).size / 1e7, uses: [] });
    await generateGlbCandidates({ sourcePath: file, outputDir: path.join(directory, 'resume'), settings: { maxEvaluations: 5, seed: 17 }, evaluate,
      onObservation: async (observation) => observations.push(observation) });
    let resumedEvaluations = 0;
    const resumed = await generateGlbCandidates({ sourcePath: file, outputDir: path.join(directory, 'resume'), settings: { maxEvaluations: 8, seed: 17 }, observations,
      evaluate: async (...args) => { resumedEvaluations++; return evaluate(...args); } });
    const fresh = await generateGlbCandidates({ sourcePath: file, outputDir: path.join(directory, 'fresh'), settings: { maxEvaluations: 8, seed: 17 }, evaluate });
    assert.equal(resumedEvaluations, 3);
    assert.equal(resumed.length, 8);
    assert.deepEqual(resumed.map((candidate) => candidate.hash), fresh.map((candidate) => candidate.hash));
    assert.ok(resumed.slice(5).some((candidate) => new Set(Object.values(candidate.params.geometry)).size > 1), 'Search must explore per-resource combinations.');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('normal plus UV attributes with no vertex color simplify without a stale component stride', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assetfit-glb-uv-'));
  try {
    const { file, document } = await fixture(directory);
    for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) primitive.setAttribute('COLOR_0', null);
    await new NodeIO().registerExtensions([KHRTextureTransform]).write(file, document);
    const candidates = await generateGlbCandidates({ sourcePath: file, outputDir: path.join(directory, 'out'), settings: { maxEvaluations: 5 },
      evaluate: async () => ({ loss: 0, uses: [] }) });
    assert.equal(candidates.length, 5);
    assert.ok(candidates.every((candidate) => candidate.valid), JSON.stringify(candidates.map((candidate) => candidate.diagnostics.error)));
    assert.ok(candidates.slice(1).every((candidate) => candidate.diagnostics.geometryChanges.some((change) => change.after < change.before)));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('transparent color images and data textures retain exact source bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assetfit-glb-alpha-'));
  try {
    const { file, document } = await fixture(directory);
    const image = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 230, g: 140, b: 30, alpha: 0.6 } } }).png().toBuffer();
    document.getRoot().listTextures()[0].setImage(image);
    document.getRoot().listMaterials()[0].setAlphaMode('BLEND');
    const io = new NodeIO().registerExtensions([KHRTextureTransform]);
    await io.write(file, document);
    const capability = await inspectGlb(file);
    assert.ok(capability.textureGroups.every((group) => !group.optimizable));
    const sourceTextures = (await io.read(file)).getRoot().listTextures().map((texture) => digest(texture.getImage()));
    const candidates = await generateGlbCandidates({ sourcePath: file, outputDir: path.join(directory, 'out'), settings: { maxEvaluations: 3 },
      evaluate: async () => ({ loss: 0, uses: [] }) });
    assert.ok(candidates.every((candidate) => candidate.valid));
    for (const candidate of candidates) {
      const textures = (await io.read(candidate.file)).getRoot().listTextures().map((texture) => digest(texture.getImage()));
      assert.deepEqual(textures, sourceTextures);
      assert.deepEqual(candidate.params.textures, {});
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('interrupted proposals retry physical work without restarting the logical search allowance', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assetfit-glb-interrupted-'));
  try {
    const { file } = await fixture(directory);
    const observations = [];
    const controller = new AbortController();
    const evaluate = async () => ({ loss: 0, uses: [] });
    await assert.rejects(generateGlbCandidates({ sourcePath: file, outputDir: path.join(directory, 'out'), signal: controller.signal,
      settings: { maxEvaluations: 5 }, evaluate,
      onObservation: async (observation) => { observations.push(observation); if (observation.event === 'proposal' && observation.attempt === 3) controller.abort(); } }), { name: 'AbortError' });
    let physical = 0;
    const retries = [];
    const resumed = await generateGlbCandidates({ sourcePath: file, outputDir: path.join(directory, 'out'), settings: { maxEvaluations: 5 }, observations,
      onObservation: async (observation) => { if (observation.event === 'candidate-retry') retries.push(observation); },
      evaluate: async () => { physical++; return evaluate(); } });
    assert.equal(resumed.length, 5);
    assert.equal(physical, 3);
    assert.equal(retries.length, 1);
    assert.equal(retries[0].attempt, 3);
    assert.equal(retries[0].logicalEvaluationAlreadyCounted, true);
    assert.ok(observations.find((observation) => observation.event === 'cancelled-candidate').costMs >= 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('raw texture, sampler and PBR metadata survive normalized library serialization', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assetfit-glb-metadata-'));
  try {
    const { file } = await fixture(directory);
    const original = await fs.readFile(file);
    const source = parseGlb(original).json;
    source.textures[0].name = 'Color texture reference';
    source.textures[0].extras = { userTag: 'important print' };
    source.samplers[0].name = 'Mirrored sampler';
    source.samplers[0].extras = ['retained', 3];
    source.materials[0].pbrMetallicRoughness.extras = { purpose: 'material settings' };
    source.extras = ['top level metadata', { version: 1 }];
    await fs.writeFile(file, preserveGlbMetadata(source, original));
    const capabilities = await inspectGlb(file);
    assert.equal(capabilities.supported, true);
    const candidates = await generateGlbCandidates({ sourcePath: file, outputDir: path.join(directory, 'out'), asset: { capabilities }, settings: { maxEvaluations: 3 },
      evaluate: async () => ({ loss: 0, uses: [] }) });
    assert.ok(candidates.every((candidate) => candidate.valid), JSON.stringify(candidates.map((candidate) => candidate.diagnostics.error)));
    for (const candidate of candidates) {
      const output = parseGlb(await fs.readFile(candidate.file)).json;
      assert.deepEqual(output.textures, source.textures);
      assert.deepEqual(output.samplers, source.samplers);
      assert.deepEqual(output.extras, source.extras);
      assert.deepEqual(output.materials[0].pbrMetallicRoughness.extras, source.materials[0].pbrMetallicRoughness.extras);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
