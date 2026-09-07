import assert from 'node:assert/strict';
import test from 'node:test';
import { CadCanvasRenderer, CadWebGLRenderer, CadViewer } from '../dist/cad-viewer.es.js';

for (const [Renderer, overlay] of [[CadCanvasRenderer, false], [CadWebGLRenderer, true]]) {
  test(`${Renderer.name} redraws before copying all layers`, () => {
    const events = [];
    const snapshot = { getContext: () => ({ drawImage: source => events.push(source.id) }) };
    const document = { createElement: tag => { assert.equal(tag, 'canvas'); return snapshot; } };
    const canvas = { id: 'vectors', width: 800, height: 600, ownerDocument: document };
    const target = {
      canvas,
      overlayCanvas: overlay ? { ...canvas, id: 'text' } : undefined,
      render: () => events.push('paint'),
    };
    assert.equal(Renderer.prototype.captureCanvas.call(target), snapshot);
    assert.deepEqual(events, overlay ? ['paint', 'vectors', 'text'] : ['paint', 'vectors']);
    assert.equal(snapshot.width, 800);
    assert.equal(snapshot.height, 600);
  });
}

test('capture rejects an unloaded viewer and delegates to the active native renderer', async () => {
  await assert.rejects(CadViewer.prototype.captureCanvas.call({}), /No CAD document/);
  const snapshot = {};
  const native = { captureCanvas: async () => snapshot };
  const viewer = { lastResult: {}, activeNativeLoader: native, renderer: { captureCanvas() { throw Error('wrong backend'); } } };
  assert.equal(await CadViewer.prototype.captureCanvas.call(viewer), snapshot);
  viewer.activeNativeLoader = {};
  await assert.rejects(CadViewer.prototype.captureCanvas.call(viewer), /does not support capture/);
});

test('empty canvases fail instead of exporting a blank success', () => {
  assert.throws(() => CadCanvasRenderer.prototype.captureCanvas.call({ canvas: { width: 0, height: 0 }, render() {} }), /not ready/);
});
