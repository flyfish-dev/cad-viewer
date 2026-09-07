import assert from 'node:assert/strict';
import test from 'node:test';
import { DxfLoader } from '../dist/cad-viewer.es.js';

test('real DXF LINE parser vertices become renderable endpoints', async () => {
  const lines = [0, 'SECTION', 2, 'ENTITIES'];
  for (const [color, y] of [[1, 0], [3, 40], [5, 80]]) {
    lines.push(0, 'LINE', 8, '0', 62, color, 10, 0, 20, y, 30, 0, 11, 100, 21, y + 15, 31, 0);
  }
  lines.push(0, 'ENDSEC', 0, 'EOF');
  const result = await new DxfLoader().load({ fileName: 'colors.dxf', buffer: Buffer.from(lines.join('\n') + '\n') });
  assert.equal(result.document.entities.length, 3);
  result.document.entities.forEach((line, index) => {
    assert.deepEqual(line.startPoint, { x: 0, y: index * 40, z: 0 });
    assert.deepEqual(line.endPoint, { x: 100, y: index * 40 + 15, z: 0 });
    assert.equal(line.colorIndex, [1, 3, 5][index]);
    assert.equal(result.raw.entities[index].startPoint, undefined, 'Normalizer rewrote parser-owned data');
  });
});

test('block LINEs use the same endpoint normalization', async () => {
  const pairs = [0, 'SECTION', 2, 'BLOCKS', 0, 'BLOCK', 2, 'B', 70, 0, 10, 0, 20, 0,
    0, 'LINE', 8, '0', 10, 8, 20, 9, 30, 0, 11, 10, 21, 11, 31, 0,
    0, 'ENDBLK', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', 0, 'INSERT', 2, 'B', 10, 0, 20, 0, 0, 'ENDSEC', 0, 'EOF'];
  const { document } = await new DxfLoader().load({ fileName: 'block.dxf', buffer: Buffer.from(pairs.join('\n') + '\n') });
  assert.deepEqual(document.blocks.B.entities[0].startPoint, { x: 8, y: 9, z: 0 });
  assert.deepEqual(document.blocks.B.entities[0].endPoint, { x: 10, y: 11, z: 0 });
});
