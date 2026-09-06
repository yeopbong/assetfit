import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { createRenderer } from '../src/renderer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('real GLB file reload has repeatable fixed views and separately recorded final views', {
  skip: process.env.ASSETFIT_RENDER_TESTS !== '1', timeout: 120_000,
}, async () => {
  const renderer = await createRenderer({ workDir: path.join(root, '.cache/renderer-test') });
  try {
    const source = path.join(root, 'examples/sources/Duck.glb');
    const context = await renderer.reference(source, [{ width: 256, height: 256, dpr: 1, weight: 1 }]);
    const originalCameras = JSON.stringify(context.uses[0].cameras);
    const first = await renderer.evaluate(source, context);
    const repeated = await renderer.evaluate(source, context);
    const heldout = await renderer.evaluate(source, context, { heldout: true });
    assert.equal(first.loss, 0);
    assert.equal(repeated.loss, 0);
    assert.equal(heldout.loss, 0);
    assert.equal(first.stage, 'search');
    assert.equal(heldout.stage, 'heldout');
    assert.equal(first.images.length, 3);
    assert.equal(heldout.images.length, 2);
    assert.equal(JSON.stringify(context.uses[0].cameras), originalCameras);
    assert(first.valid);
    assert(context.referenceImages.every(image => image.foregroundPixels > 0));
    const changedUsage = await renderer.reference(source, [{ width: 128, height: 256, dpr: 1, weight: 1 }]);
    assert.notEqual(changedUsage.settingsHash, context.settingsHash);
    assert.equal(changedUsage.uses[0].width, 128);
    assert.equal(changedUsage.uses[0].height, 256);
    const io = new NodeIO();
    const moved = await io.read(source);
    for (const node of moved.getRoot().getDefaultScene().listChildren()) {
      const translation = node.getTranslation();
      node.setTranslation([translation[0] + context.bounds.radius * 1000, translation[1], translation[2]]);
    }
    const movedPath = path.join(root, '.cache/renderer-test/moved-duck.glb');
    await io.write(movedPath, moved);
    const absent = await renderer.evaluate(movedPath, context);
    assert.equal(absent.valid, false);
    assert(absent.loss > 0.4);
    assert(absent.uses.every(usage => usage.views.every(view => view.vanishedForeground)));
    assert.equal(JSON.stringify(context.uses[0].cameras), originalCameras);

    const narrow = await io.read(source);
    const base = narrow.getRoot().getDefaultScene().listChildren()[0];
    const scale = base.getScale();
    base.setScale([scale[0] * 0.4, scale[1], scale[2]]);
    const narrowPath = path.join(root, '.cache/renderer-test/narrow-duck.glb');
    await io.write(narrowPath, narrow);
    const silhouette = await renderer.evaluate(narrowPath, context);
    assert(silhouette.loss > 0.001);
    assert(silhouette.uses[0].views.some(view => view.silhouette > 0.01));

    const detailed = await io.read(source);
    const detail = detailed.createNode('Inspection detail part').setMesh(detailed.getRoot().listMeshes()[0])
      .setScale([0.002, 0.002, 0.002]).setTranslation([2, 0.8, 0]);
    detailed.getRoot().getDefaultScene().addChild(detail);
    const detailedPath = path.join(root, '.cache/renderer-test/duck-with-detail.glb');
    await io.write(detailedPath, detailed);
    const detailReference = await renderer.reference(detailedPath, [{ width: 256, height: 256, dpr: 1 }]);
    detail.dispose();
    const missingPath = path.join(root, '.cache/renderer-test/duck-missing-detail.glb');
    await io.write(missingPath, detailed);
    const missing = await renderer.evaluate(missingPath, detailReference);
    assert(missing.loss > 0.0001);
    assert(missing.uses[0].views.some(view => view.missingForeground > 0.005));
    assert(missing.valid, 'A local missing part is damage, not full disappearance.');
  } finally { await renderer.close(); }
});
