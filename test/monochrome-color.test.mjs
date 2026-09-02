import assert from 'node:assert/strict';
import test from 'node:test';

import {
  colorFromAci,
  createCadRenderDocument,
  readCadColorPolicy,
  resolveCadColor,
  resolveFillColor
} from '../dist/cad-viewer.es.js';

const createDocument = () => ({
  format: 'dxf',
  layers: {
    Walls: { name: 'Walls', color: '#ff0000' }
  },
  blocks: {},
  entities: [],
  metadata: {},
  warnings: []
});

test('monochrome render policy is non-destructive', () => {
  const source = createDocument();
  const rendered = createCadRenderDocument(source, {
    mode: 'monochrome',
    monochromeColor: '#102030'
  });

  assert.notEqual(rendered, source);
  assert.notEqual(rendered.metadata, source.metadata);
  assert.deepEqual(source.metadata, {});
  assert.deepEqual(readCadColorPolicy(rendered), {
    mode: 'monochrome',
    monochromeColor: '#102030'
  });
  assert.equal(readCadColorPolicy(source).mode, 'source');
});

test('monochrome mode overrides entity, layer and fill colors', () => {
  const rendered = createCadRenderDocument(createDocument(), {
    mode: 'monochrome',
    monochromeColor: '#102030'
  });

  assert.equal(
    resolveCadColor({ type: 'LINE', color: '#ff0000' }, rendered),
    'rgb(16, 32, 48)'
  );
  assert.equal(
    resolveCadColor({ type: 'LINE', layer: 'Walls' }, rendered),
    'rgb(16, 32, 48)'
  );
  assert.equal(
    resolveFillColor({ type: 'HATCH', fillColor: '#00ff00' }, rendered),
    'rgb(16, 32, 48)'
  );
});

test('monochrome mode preserves source and target alpha', () => {
  const rendered = createCadRenderDocument(createDocument(), {
    mode: 'monochrome',
    monochromeColor: 'rgba(16, 32, 48, 0.5)'
  });

  assert.equal(
    resolveCadColor({ type: 'LINE', color: 'rgba(255, 0, 0, 0.5)' }, rendered),
    'rgba(16, 32, 48, 0.25)'
  );
  assert.equal(
    resolveFillColor({ type: 'HATCH', fillColor: 'rgba(0, 255, 0, 0.25)' }, rendered),
    'rgba(16, 32, 48, 0.125)'
  );
});

test('source mode preserves authored colors and the ACI table', () => {
  const source = createDocument();
  assert.equal(resolveCadColor({ type: 'LINE', color: '#ff0000' }, source), '#ff0000');
  assert.equal(resolveFillColor({ type: 'HATCH', fillColor: '#00ff00' }, source), '#00ff00');
  assert.equal(colorFromAci(105), '#3f7f4f');
});
