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
