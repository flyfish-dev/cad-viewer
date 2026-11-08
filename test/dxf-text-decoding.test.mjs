import assert from 'node:assert/strict';
import test from 'node:test';
import { DxfLoader } from '../dist/cad-viewer.es.js';

const ascii = (value) => Buffer.from(value, 'latin1');

function dxfWithText({ version, codepage, textBytes }) {
  const header = [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', version,
    ...(codepage ? ['9', '$DWGCODEPAGE', '3', codepage] : []),
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'TEXT', '8', '0', '10', '0', '20', '0', '40', '2', '1'
  ].join('\n') + '\n';
  return Buffer.concat([ascii(header), textBytes, ascii('\n0\nENDSEC\n0\nEOF\n')]);
}

async function loadTextField(options) {
  const { document } = await new DxfLoader().load({
    fileName: 'text.dxf',
    buffer: dxfWithText(options)
  });
  return document.entities[0].text;
}

test('DXF R2018 UTF-8 text is not decoded with a stale ANSI_936 codepage', async () => {
  const text = await loadTextField({
    version: 'AC1032',
    codepage: 'ANSI_936',
    textBytes: Buffer.from('助针器上盖', 'utf8')
  });
  assert.equal(text, '助针器上盖');
});

test('DXF R2000 GBK text still decodes through ANSI_936', async () => {
  const text = await loadTextField({
    version: 'AC1015',
    codepage: 'ANSI_936',
    textBytes: Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4])
  });
  assert.equal(text, '中文测试');
});

test('\\U+XXXX escape consumes exactly four hex digits', async () => {
  const text = await loadTextField({
    version: 'AC1015',
    codepage: 'ANSI_1252',
    textBytes: ascii('A\\U+80033D B')
  });
  assert.equal(text, 'A考3D B');
});

test('\\U+XXXX surrogate pairs still decode to one non-BMP character', async () => {
  const text = await loadTextField({
    version: 'AC1015',
    codepage: 'ANSI_1252',
    textBytes: ascii('A\\U+D83D\\U+DE00B')
  });
  assert.equal(text, 'A😀B');
});

test('DXF R2007 UTF-8 text is not decoded with a stale ANSI_1252 codepage', async () => {
  const text = await loadTextField({
    version: 'AC1021',
    codepage: 'ANSI_1252',
    textBytes: Buffer.from('中文测试', 'utf8')
  });
  assert.equal(text, '中文测试');
});

test('an explicit dxfEncoding override still wins over the version rule', async () => {
  const buffer = dxfWithText({
    version: 'AC1032',
    codepage: 'ANSI_936',
    textBytes: Buffer.from('中文测试', 'utf8')
  });
  const { document } = await new DxfLoader().load(
    { fileName: 'text.dxf', buffer },
    { dxfEncoding: 'gb18030' }
  );
  assert.notEqual(document.entities[0].text, '中文测试');
});

test('\\U+XXXX escapes in ATTRIB text decoded by the BOM supplement are bounded too', async () => {
  const pairs = [
    0, 'SECTION', 2, 'ENTITIES',
    0, 'INSERT', 5, '10', 2, 'B', 10, 0, 20, 0,
    0, 'ATTRIB', 5, '11', 330, '10', 2, 'TAG', 1, 'A\\U+80033D B', 10, 0, 20, 0, 40, 2,
    0, 'SEQEND', 0, 'ENDSEC', 0, 'EOF'
  ];
  const { document } = await new DxfLoader().load({
    fileName: 'attrib.dxf',
    buffer: Buffer.from(pairs.join('\n') + '\n')
  });
  assert.equal(document.entities[0].attribs[0].text, 'A考3D B');
});

test('DXF R2007 UTF-8 text without a $DWGCODEPAGE declaration decodes as UTF-8', async () => {
  const text = await loadTextField({
    version: 'AC1021',
    codepage: undefined,
    textBytes: Buffer.from('中文测试', 'utf8')
  });
  assert.equal(text, '中文测试');
});
