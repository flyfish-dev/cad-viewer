import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDwgDatabase } from '../dist/cad-viewer.es.js';

const styles = { STYLE: { entries: [
  { handle: 'A1', name: 'Narrow', widthFactor: 0.8, font: 'txt.shx' },
  { handle: 'A2', name: 'Roman', widthFactor: 0.7, font: 'C:\\Fonts\\times.ttf' },
  { handle: 'A3', name: 'Invalid', widthFactor: -1, font: '' }
] } };

test('DWG MTEXT inherits STYLE width and font in the worker-safe document', () => {
  const document = normalizeDwgDatabase({ tables: styles, entities: [{
    type: 'MTEXT', styleName: 'Narrow', text: 'Construction notes\\PMaterials shall be inspected.',
    textHeight: 3.5, rectWidth: 138.87, attachmentPoint: 1, lineSpacing: 1
  }] });
  const entity = document.entities[0];
  assert.equal(entity.textStyleWidthFactor, 0.8);
  assert.equal(entity.xScale, undefined);
  assert.equal(entity.width, 138.87);
  assert.equal(entity.fontFamily, 'txt.shx');
  assert.equal(entity.raw, undefined);
  assert.deepEqual(structuredClone(document).entities[0], entity);
});

test('DWG explicit text widths override STYLE defaults and block attributes inherit their own style', () => {
  const document = normalizeDwgDatabase({ tables: styles, entities: [
    { type: 'TEXT', styleName: 'Narrow', text: 'A', xScale: 1.25 },
    { type: 'INSERT', name: 'Label', attribs: [{ type: 'ATTRIB', text: { text: 'B', styleName: 'Roman' } }] }
  ], blocks: [{ name: 'Label', entities: [{ type: 'TEXT', styleName: 'Roman', text: 'C' }] }] });
  assert.equal(document.entities[0].xScale, 1.25);
  assert.equal(document.entities[1].attribs[0].xScale, 0.7);
  assert.equal(document.entities[1].attribs[0].fontFamily, 'Times New Roman');
  assert.equal(document.blocks.Label.entities[0].xScale, 0.7);
});

test('DWG MTEXT direction overrides the LibreDWG placeholder rotation', () => {
  const document = normalizeDwgDatabase({ entities: [{
    type: 'MTEXT', text: 'Rotated note', rotation: 0, direction: { x: 0, y: 1, z: 0 }
  }] });
  assert.equal(document.entities[0].rotation, Math.PI / 2);
});

test('missing or invalid DWG style properties keep ordinary text defaults', () => {
  const document = normalizeDwgDatabase({ tables: styles, entities: [
    { type: 'TEXT', styleName: 'Invalid', text: 'A' },
    { type: 'MTEXT', styleName: 'Missing', text: 'B', direction: { x: 0, y: 0 }, rotation: 0.25 }
  ] });
  assert.equal(document.entities[0].xScale, undefined);
  assert.equal(document.entities[0].fontFamily, undefined);
  assert.equal(document.entities[1].rotation, 0.25);
});
