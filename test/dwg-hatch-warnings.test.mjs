import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDwgDatabase } from '../dist/cad-viewer.es.js';

const unsupportedHatch = () => ({
  type: 'HATCH', solidFill: 1,
  boundaryPaths: [{ isClosed: true, vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] }]
});

test('unused block hatches retain diagnostics without warning about the visible model', () => {
  const document = normalizeDwgDatabase({ entities: [{ type: 'TEXT', text: 'Model' }], blocks: [
    { name: 'Unused', entities: [unsupportedHatch()] }
  ] });
  assert.deepEqual(document.warnings, []);
  assert.equal(document.blocks.Unused.entities[0].hatch.status, 'unsupported');
  assert.equal(document.blocks.Unused.entities[0].hatch.diagnostics.length, 1);
});

test('reachable nested block hatch warnings are retained and cyclic references terminate', () => {
  const document = normalizeDwgDatabase({ entities: [{ type: 'INSERT', name: 'Outer' }], blocks: [
    { name: 'Outer', entities: [{ type: 'INSERT', name: 'Inner' }] },
    { name: 'Inner', entities: [unsupportedHatch(), { type: 'INSERT', name: 'Outer' }] }
  ] });
  assert.equal(document.warnings.length, 1);
  assert.match(document.warnings[0], /HATCH/);
});
