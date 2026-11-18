import assert from 'node:assert/strict';
import test from 'node:test';
import { DxfLoader } from '../dist/cad-viewer.es.js';

test('DXF layer table records reach the normalized document', async () => {
  const pairs = [
    0, 'SECTION', 2, 'TABLES',
    0, 'TABLE', 2, 'LAYER', 70, 3,
    0, 'LAYER', 2, '0', 70, 0, 62, 7, 6, 'CONTINUOUS',
    0, 'LAYER', 2, 'TEXT_LAYER', 70, 0, 62, 1, 6, 'CONTINUOUS',
    0, 'LAYER', 2, 'OFF_LAYER', 70, 0, 62, -5, 6, 'CONTINUOUS',
    0, 'ENDTAB',
    0, 'ENDSEC',
    0, 'SECTION', 2, 'ENTITIES',
    0, 'TEXT', 8, 'TEXT_LAYER', 10, 0, 20, 0, 40, 2, 1, 'Hello',
    0, 'ENDSEC', 0, 'EOF'
  ];
  const { document } = await new DxfLoader().load({
    fileName: 'layers.dxf',
    buffer: Buffer.from(pairs.join('\n') + '\n')
  });
  assert.ok(document.layers.TEXT_LAYER, `layers: ${Object.keys(document.layers).join(', ')}`);
  assert.equal(document.layers.TEXT_LAYER.colorIndex, 1);
  assert.equal(document.layers.TEXT_LAYER.isVisible, true);
  assert.equal(document.layers.OFF_LAYER?.colorIndex, 5);
  assert.equal(document.layers.OFF_LAYER?.isVisible, false);
  assert.ok(document.layers['0']);
});

test('layer freeze, lock, true color and line appearance survive the real parser', async () => {
  const pairs = [
    0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, 5,
    0, 'LAYER', 2, 'FROZEN', 70, 1, 62, 7, 6, 'CONTINUOUS',
    0, 'LAYER', 2, 'NEW_VIEWPORT_FROZEN', 70, 2, 62, 3, 6, 'CONTINUOUS',
    0, 'LAYER', 2, 'LOCKED', 70, 4, 62, 2, 6, 'DASHED', 370, 50,
    0, 'LAYER', 2, 'RGB_OFF', 70, 0, 62, -1, 420, 0x123456, 6, 'CONTINUOUS',
    0, 'LAYER', 2, '__proto__', 70, 0, 62, 4, 6, 'CONTINUOUS',
    0, 'ENDTAB', 0, 'ENDSEC',
    0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 8, 'LOCKED', 10, 0, 20, 0, 11, 10, 21, 10,
    0, 'ENDSEC', 0, 'EOF'
  ];
  const { document } = await new DxfLoader().load({ fileName: 'appearance.dxf', buffer: Buffer.from(pairs.join('\n') + '\n') });
  assert.equal(document.layers.FROZEN.isFrozen, true);
  assert.equal(document.layers.NEW_VIEWPORT_FROZEN.isFrozen, false, 'new-viewport freeze must not hide model-space content');
  assert.equal(document.layers.LOCKED.isLocked, true);
  assert.equal(document.layers.LOCKED.isVisible, true, 'locking does not hide a layer');
  assert.equal(document.layers.LOCKED.lineType, 'DASHED');
  assert.equal(document.layers.LOCKED.lineweight, 50);
  assert.equal(document.layers.RGB_OFF.trueColor, 0x123456);
  assert.equal(document.layers.RGB_OFF.colorIndex, 1);
  assert.equal(document.layers.RGB_OFF.isVisible, false);
  assert.equal(Object.getPrototypeOf(document.layers), null, 'untrusted layer names cannot replace the dictionary prototype');
  assert.equal(document.layers.__proto__.name, '__proto__');
  assert.equal(document.layers.__proto__.colorIndex, 4);
});
