import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DxfLoader,
  extractCadBom,
  normalizeCadEntity,
  normalizeDwgDatabase,
  serializeCadBomCsv,
  serializeCadBomJson
} from '../dist/cad-viewer.es.js';

const cadDocument = (overrides = {}) => ({
  format: 'dwg',
  sourceName: 'bom-fixture.dwg',
  header: {},
  layers: {},
  blocks: {},
  entities: [],
  metadata: {},
  warnings: [],
  ...overrides
});

const tableBySource = (bom, source) => {
  const table = bom.tables.find((candidate) => candidate.source === source);
  assert.ok(table, `expected a ${source} BOM table`);
  return table;
};

test('worker-safe DWG normalization retains nested ATTRIB/ATTDEF data, deduplicates converter ATTRIB echoes and applies MINSERT quantity', () => {
  const raw = {
    tables: {
      BLOCK_RECORD: {
        entries: [{
          handle: 'B1',
          name: 'Pump',
          entities: [{
            type: 'ATTDEF',
            handle: 'D1',
            tag: 'Part_No',
            flags: 0,
            text: { text: 'P-DEFAULT' }
          }, {
            type: 'ATTDEF',
            handle: 'D2',
            tag: 'MATERIAL',
            flags: 2,
            text: { text: '316L' }
          }]
        }]
      }
    },
    entities: [{
      type: 'INSERT',
      handle: 'I1',
      name: 'Pump',
      layer: 'Equipment',
      rowCount: 2,
      columnCount: 3,
      attribs: [{ type: 'ATTRIB', handle: 'A1', tag: ' part_no ', flags: 0, text: { text: 'P-001' } }]
    }, {
      type: 'ATTRIB',
      handle: 'A1',
      tag: 'part_no',
      text: { text: 'P-001' }
    }, {
      type: 'INSERT',
      handle: 'I2',
      name: 'Pump',
      layer: 'Spare',
      rowCount: 0,
      columnCount: 0,
      attribs: [{ type: 'ATTRIB', handle: 'A2', tag: 'PART_NO', flags: 0, text: { text: 'P-001' } }]
    }, {
      type: 'ATTRIB',
      handle: 'A2',
      tag: 'PART_NO',
      text: { text: 'P-001' }
    }]
  };

  const document = normalizeDwgDatabase(raw, 'worker-safe.dwg', undefined, { keepRaw: false });
  const insert = document.entities.find((entity) => entity.handle === 'I1');
  assert.equal(document.raw, undefined);
  assert.equal(insert?.attribs?.[0]?.attributeTag, ' part_no ');
  assert.equal(insert?.attribs?.[0]?.text, 'P-001');
  assert.equal(insert?.insertRowCount, 2);
  assert.equal(insert?.insertColumnCount, 3);
  assert.equal(document.entities.find((entity) => entity.handle === 'I2')?.insertRowCount, undefined, 'ordinary INSERT zero counts normalize to one at extraction time');

  const bom = extractCadBom(document, { sources: ['block-attributes'] });
  const table = tableBySource(bom, 'block-attributes');
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].quantity, 7, '2×3 MINSERT instances plus one ordinary INSERT');
  assert.deepEqual(new Set(table.rows[0].sourceHandles), new Set(['I1', 'I2']));
  assert.equal(table.rows[0].cells.item, 'Pump');
  assert.equal(table.rows[0].cells.part_no, 'P-001', 'instance ATTRIB overrides ATTDEF case-insensitively');
  assert.equal(table.rows[0].cells.material, '316L', 'unmatched ATTDEF default remains available');
  assert.equal(table.rows[0].cells.layers, 'Equipment, Spare');
  assert.ok(!bom.warnings.some((warning) => warning.code === 'duplicate-attribute'), 'an ATTDEF overridden by one ATTRIB is not a duplicate');
  assert.equal(bom.summary.blockItemCount, 1);
  assert.equal(bom.summary.blockQuantity, 7);
  assert.doesNotThrow(() => structuredClone(bom));
});

test('duplicate instance attributes warn and use the last value without mutating the source', () => {
  const attributes = [
    { type: 'ATTRIB', handle: 'A1', attributeTag: 'CODE', text: 'first' },
    { type: 'ATTRIB', handle: 'A2', attributeTag: ' code ', text: 'second' }
  ];
  const document = cadDocument({
    entities: [{ type: 'INSERT', kind: 'insert', handle: 'I1', blockName: 'Valve', attribs: attributes }]
  });
  const before = JSON.stringify(document);
  const bom = extractCadBom(document, { sources: ['block-attributes'], recursiveBlocks: false });
  const table = tableBySource(bom, 'block-attributes');

  assert.equal(table.rows[0].cells.code, 'second');
  assert.ok(bom.warnings.some((warning) => warning.code === 'duplicate-attribute'));
  assert.equal(JSON.stringify(document), before, 'BOM extraction is an immutable derivative');
});

test('recursive block traversal multiplies shared leaf occurrences, ignores lowercase block aliases and terminates cycles/depth limits', () => {
  const leaf = { name: 'Leaf', entities: [] };
  const assembly = {
    name: 'Assembly',
    entities: [{ type: 'INSERT', kind: 'insert', handle: 'LEAF-REF', blockName: 'Leaf', insertRowCount: 2, insertColumnCount: 2 }]
  };
  const document = cadDocument({
    blocks: { Assembly: assembly, assembly, Leaf: leaf, leaf },
    entities: [{ type: 'INSERT', kind: 'insert', handle: 'ROOT', blockName: 'Assembly', insertRowCount: 2 }]
  });
  const bom = extractCadBom(document, { sources: ['block-attributes'] });
  const rows = Object.fromEntries(tableBySource(bom, 'block-attributes').rows.map((row) => [row.cells.item, row]));
  assert.equal(rows.Assembly.quantity, 2);
  assert.equal(rows.Leaf.quantity, 8);
  assert.equal(Object.keys(rows).length, 2, 'case aliases in document.blocks are not traversed as separate definitions');

  const loop = { name: 'Loop', entities: [] };
  loop.entities.push({ type: 'INSERT', kind: 'insert', handle: 'LOOP-CHILD', blockName: 'Loop' });
  const cyclic = cadDocument({
    blocks: { Loop: loop, loop },
    entities: [{ type: 'INSERT', kind: 'insert', handle: 'LOOP-ROOT', blockName: 'Loop' }]
  });
  const cyclicBom = extractCadBom(cyclic, { sources: ['block-attributes'], maxDepth: 8 });
  assert.ok(cyclicBom.warnings.some((warning) => warning.code === 'cyclic-block'));
  assert.ok(cyclicBom.summary.blockQuantity <= 2);
  assert.ok(Number.isSafeInteger(cyclicBom.summary.blockQuantity));

  const blocks = {};
  for (let index = 0; index < 6; index += 1) {
    const name = `Depth${index}`;
    blocks[name] = { name, entities: index < 5 ? [{ type: 'INSERT', kind: 'insert', blockName: `Depth${index + 1}` }] : [] };
  }
  const depthBom = extractCadBom(cadDocument({
    blocks,
    entities: [{ type: 'INSERT', kind: 'insert', blockName: 'Depth0' }]
  }), { sources: ['block-attributes'], maxDepth: 2 });
  assert.ok(depthBom.warnings.some((warning) => warning.code === 'max-depth'));
  assert.ok(!tableBySource(depthBom, 'block-attributes').rows.some((row) => row.cells.item === 'Depth3'));
});

test('0.7.9-shaped ACAD_TABLE cached cells survive normalization and are returned without following a DataLink', () => {
  const raw = {
    objects: {
      DATALINK: [{
        handle: 'DL-1',
        dataAdapter: 'AcExcel',
        connectionString: 'file:///private/customer/parts.xlsx',
        updateStatus: 'stale'
      }]
    },
    entities: [{
      type: 'ACAD_TABLE',
      handle: 'T1',
      name: 'Fallback name',
      rowCount: 4,
      columnCount: 4,
      dataLink: 'DL-1',
      cells: [
        { text: 'Door schedule' }, { text: '' }, { text: '' }, { text: '' },
        { text: 'Item' }, { text: 'Part No' }, { text: 'Description' }, { text: 'Quantity' },
        { text: '1' }, { value: { valueString: 'D-100' } }, { text: 'Door, left' }, { text: '2' },
        { text: '2' }, { text: 'D-200' }, { text: 'Door right' }, { value: { dataLong: 4 } }
      ]
    }]
  };
  const document = normalizeDwgDatabase(raw, 'table-cache.dwg', undefined, { keepRaw: false });
  const normalized = document.entities[0];
  assert.equal(normalized.kind, 'table');
  assert.equal(normalized.table?.cells[9]?.text, 'D-100', 'typed cached TABLE values are unwrapped before generic objects');
  assert.equal(document.dataLinks?.[0]?.handle, 'DL-1');

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('BOM extraction must not fetch external DataLinks');
  };
  try {
    const bom = extractCadBom(document, { sources: ['native-table'] });
    const table = tableBySource(bom, 'native-table');
    assert.equal(fetchCalls, 0);
    assert.equal(table.name, 'Door schedule');
    assert.equal(table.dataLink?.updateStatus, 'stale');
    assert.deepEqual(table.columns.map((column) => column.key), ['item', 'part_no', 'description', 'quantity']);
    assert.deepEqual(table.rows.map((row) => row.cells), [{
      item: 1,
      part_no: 'D-100',
      description: 'Door, left',
      quantity: 2
    }, {
      item: 2,
      part_no: 'D-200',
      description: 'Door right',
      quantity: 4
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('native TABLE count mismatches and missing modern TABLECONTENT caches degrade safely', () => {
  const hugeDeclared = normalizeCadEntity({
    type: 'ACAD_TABLE',
    handle: 'T-HUGE',
    rowCount: 1_000_000_000,
    columnCount: 1_000_000_000,
    cells: [
      { text: 'Part' }, { text: 'Quantity' },
      { text: 'P-1' }, { text: '2' }
    ]
  }, undefined, { includeUnknownProperties: false });
  const emptyModern = normalizeCadEntity({
    type: 'ACAD_TABLE',
    handle: 'T-EMPTY',
    rowCount: 63,
    columnCount: 256,
    cells: []
  }, undefined, { includeUnknownProperties: false });
  const bom = extractCadBom(cadDocument({ entities: [hugeDeclared, emptyModern] }), { sources: ['native-table'], maxCells: 16 });

  assert.equal(tableBySource(bom, 'native-table').rows.length, 1, 'only actual cached cells drive allocation and output');
  assert.ok(bom.warnings.some((warning) => warning.code === 'empty-native-table' && warning.handle === 'T-EMPTY'));

  const missingLink = normalizeCadEntity({
    type: 'ACAD_TABLE',
    handle: 'T-LINK',
    rowCount: 2,
    columnCount: 2,
    dataLink: 'MISSING',
    cells: [{ text: 'Part' }, { text: 'Qty' }, { text: 'P-2' }, { text: '1' }]
  }, undefined, { includeUnknownProperties: false });
  const linkedBom = extractCadBom(cadDocument({ entities: [missingLink] }), { sources: ['native-table'] });
  assert.ok(tableBySource(linkedBom, 'native-table').warnings.some((warning) => warning.code === 'external-data-unavailable'));
  assert.ok(linkedBom.warnings.some((warning) => warning.code === 'external-data-unavailable'), 'table-local warnings are visible at the BOM root');
});

test('sparse and malicious native TABLE coordinates never allocate by the largest coordinate', { timeout: 1000 }, () => {
  const entity = {
    type: 'ACAD_TABLE',
    kind: 'table',
    handle: 'T-SPARSE',
    table: {
      rowCount: 2,
      columnCount: Number.MAX_SAFE_INTEGER,
      headerSuppressed: false,
      cells: [
        { row: 0, column: 0, text: 'Part' },
        { row: 0, column: 500_000, text: 'Quantity' },
        { row: 1, column: 0, text: 'P-1' },
        { row: 1, column: 500_000, text: '4' },
        { row: 1, column: Number.MAX_SAFE_INTEGER, text: 'malicious' },
        { row: -1, column: 1, text: 'invalid' }
      ]
    }
  };
  const bom = extractCadBom(cadDocument({ entities: [entity] }), { sources: ['native-table'], maxCells: 16 });
  const table = tableBySource(bom, 'native-table');

  assert.deepEqual(table.columns.map((column) => column.sourceKey), ['0', '500000']);
  assert.deepEqual(table.rows[0].cells, { part: 'P-1', quantity: 4 });
  assert.ok(table.warnings.some((warning) => warning.code === 'invalid-table-cell'));
  assert.ok(bom.warnings.some((warning) => warning.code === 'invalid-table-cell'));
});

test('DATATABLE and dictionary-owned XRECORD caches normalize into bounded, independent tables', { timeout: 1000 }, () => {
  const groups = Array.from({ length: 10 }, (_, index) => ({ code: index === 0 ? 1 : 90, value: index === 0 ? 'Cached schedule metadata' : index }));
  const raw = {
    objects: {
      DICTIONARY: [{ handle: 'D0', entries: { SCHEDULES: 'D1' } }, {
        handle: 'D1',
        ownerHandle: 'D0',
        entries: { DOOR_SCHEDULE: 'XR1' }
      }],
      XRECORD: [{ handle: 'XR1', ownerHandle: 'D1', data: groups }],
      DATATABLE: [{
        handle: 'DT1',
        table_name: 'Cached parts',
        num_rows: 1_000_000_000,
        num_cols: 3,
        cols: [{
          name: 'Part',
          rows: [{ value: { data_string: 'P-10' } }, { value: { data_string: 'P-20' } }]
        }, {
          name: 'Description',
          rows: [{ value: { value_string: 'Bracket' } }, { value: { value_string: 'Bolt' } }]
        }, {
          name: 'Quantity',
          rows: [{ value: { data_long: 2 } }, { value: { data_long: 8 } }]
        }]
      }]
    },
    entities: []
  };
  const document = normalizeDwgDatabase(raw, 'objects.dwg', undefined, { keepRaw: false });
  assert.deepEqual(document.xrecords?.[0]?.dictionaryPath, ['SCHEDULES', 'DOOR_SCHEDULE']);
  assert.deepEqual(document.dataTables?.[0]?.columns.map((column) => column.values), [
    ['P-10', 'P-20'],
    ['Bracket', 'Bolt'],
    [2, 8]
  ]);

  const bom = extractCadBom(document, { sources: ['data-table', 'xrecord'], maxRows: 20, maxCells: 3 });
  const dataTable = tableBySource(bom, 'data-table');
  const xrecord = tableBySource(bom, 'xrecord');
  assert.equal(dataTable.name, 'Cached parts');
  assert.equal(dataTable.rows.length, 2, 'declared rowCount does not cause empty billion-row iteration');
  assert.deepEqual(dataTable.rows[1].cells, { part: 'P-20', description: 'Bolt', quantity: 8 });
  assert.equal(xrecord.name, 'SCHEDULES / DOOR_SCHEDULE');
  assert.equal(xrecord.rows.length, 3);
  assert.ok(xrecord.warnings.some((warning) => warning.message.includes('capped')));
  assert.ok(bom.warnings.some((warning) => warning.source === 'xrecord'));
});

test('arbitrary XDATA/XRECORD application caches are opt-in and do not flood the default BOM', () => {
  const document = cadDocument({
    entities: [{ type: 'LINE', kind: 'line', handle: 'X-INTERNAL', xdata: [{ appName: 'AcDbBlockRepETag', entries: [{ code: 1000, value: 'cache' }] }] }],
    xrecords: [{ handle: 'XR-INTERNAL', entryName: 'ACAD_ENHANCEDBLOCKHISTORY', data: [{ code: 90, value: 1 }] }]
  });

  assert.equal(extractCadBom(document).tables.length, 0);
  assert.equal(tableBySource(extractCadBom(document, { sources: ['xdata'] }), 'xdata').rows.length, 1);
  assert.equal(tableBySource(extractCadBom(document, { sources: ['xrecord'] }), 'xrecord').rows.length, 1);
});

test('XDATA/property-set normalization preserves application groups, repeated codes, typed values and DXF custom strings', () => {
  const official = normalizeCadEntity({
    type: 'INSERT',
    handle: 'X1',
    name: 'Tagged part',
    xdata: [{
      appName: 'BOM_APP',
      value: [{ code: 1000, name: 'PART_NO', value: 'X-100' }, {
        code: 1070,
        name: 'QTY',
        value: 4
      }, {
        code: 1000,
        name: 'DETAILS',
        value: ['316L', { certified: true }]
      }]
    }]
  }, undefined, { includeUnknownProperties: false });
  const dxf = normalizeCadEntity({
    type: 'LINE',
    handle: 'X2',
    extendedData: {
      applicationName: 'DXF_BOM',
      customStrings: ['PART_NO=X-200', 'QTY=2']
    }
  }, undefined, { includeUnknownProperties: false });
  assert.deepEqual(dxf.xdata?.[0]?.entries, [
    { code: 1000, value: 'PART_NO=X-200' },
    { code: 1000, value: 'QTY=2' }
  ]);
  assert.doesNotThrow(() => structuredClone(official.xdata));

  const bom = extractCadBom(cadDocument({ entities: [official, dxf] }), { sources: ['xdata'] });
  const propertySet = bom.tables.find((table) => table.name === 'BOM_APP');
  const dxfTable = bom.tables.find((table) => table.name === 'DXF_BOM');
  assert.ok(propertySet);
  assert.ok(dxfTable);
  assert.equal(propertySet.rows[0].cells.part_no, 'X-100');
  assert.equal(propertySet.rows[0].cells.qty, 4);
  assert.equal(propertySet.rows[0].cells.details_1, '316L');
  assert.equal(propertySet.rows[0].cells.details_2_certified, true);
  assert.equal(dxfTable.rows[0].cells['1000'], 'PART_NO=X-200');
  assert.equal(dxfTable.rows[0].cells['1000_2'], 'QTY=2');
});

test('XDATA table IDs remain unique when application names normalize to the same slug', () => {
  const entity = (handle, appName) => ({
    type: 'LINE',
    handle,
    xdata: [{ appName, entries: [{ code: 1000, value: handle }] }]
  });
  const bom = extractCadBom(cadDocument({
    entities: [entity('X-1', 'ERP BOM'), entity('X-2', 'ERP-BOM')]
  }), { sources: ['xdata'] });

  assert.deepEqual(bom.tables.map((table) => table.id), ['xdata-erp_bom', 'xdata-erp_bom-2']);
  assert.equal(new Set(bom.tables.flatMap((table) => table.rows.map((row) => row.id))).size, 2);
});

test('text-grid reconstruction accepts a high-confidence schedule and auto mode rejects a sparse grid that forced mode can expose', () => {
  const text = (handle, textValue, x, y) => ({
    type: 'TEXT',
    kind: 'text',
    handle,
    layer: 'BOM',
    text: textValue,
    insertionPoint: { x, y },
    textHeight: 1,
    rotation: 0
  });
  const entities = [
    text('H1', 'Part No', 0, 100), text('H2', 'Description', 30.1, 100.1), text('H3', 'Quantity', 80, 99.9),
    text('A1', 'P-1', 0.1, 90), text('A2', 'Bracket', 30, 90.1), text('A3', '2', 79.9, 90),
    text('B1', 'P-2', -0.1, 80.1), text('B2', 'Bolt\\PM8', 30.2, 80), text('B3', '8', 80.1, 80.1),
    text('C1', 'P-3', 0, 70), text('C2', 'Nut', 29.9, 69.9), text('C3', '8', 80, 70)
  ];
  const bom = extractCadBom(cadDocument({ entities }), { sources: ['text-table'], textTables: 'auto' });
  const table = tableBySource(bom, 'text-table');
  assert.ok(table.confidence >= 0.82);
  assert.deepEqual(table.columns.map((column) => column.key), ['part_no', 'description', 'quantity']);
  assert.deepEqual(table.rows.map((row) => row.cells), [
    { part_no: 'P-1', description: 'Bracket', quantity: 2 },
    { part_no: 'P-2', description: 'Bolt M8', quantity: 8 },
    { part_no: 'P-3', description: 'Nut', quantity: 8 }
  ]);

  const sparse = [
    text('S1', 'Foo', 0, 100), text('S2', 'Bar', 30, 100),
    text('S3', 'A', 0, 90), text('S4', 'noise', 100, 90),
    text('S5', 'B', 30, 80), text('S6', 'noise', 120, 80),
    text('S7', 'C', 0, 70), text('S8', 'D', 30, 70)
  ];
  const automatic = extractCadBom(cadDocument({ entities: sparse }), { sources: ['text-table'], textTables: 'auto' });
  assert.equal(automatic.tables.length, 0);
  const forced = extractCadBom(cadDocument({ entities: sparse }), { sources: ['text-table'], textTables: true });
  assert.equal(forced.tables.length, 1);
  assert.ok(forced.tables[0].confidence < 0.82);
  assert.ok(forced.tables[0].warnings.some((warning) => warning.code === 'low-confidence-text-table'));
  assert.ok(forced.warnings.some((warning) => warning.code === 'low-confidence-text-table'));
});

test('large text schedules use bounded row construction and expose truncation at the BOM root', { timeout: 2000 }, () => {
  const entities = [];
  for (let row = 0; row < 6_000; row += 1) {
    const y = 10_000 - row;
    entities.push({
      type: 'TEXT', kind: 'text', handle: `P-${row}`, layer: 'LARGE_BOM',
      text: row === 0 ? 'Part' : `P-${row}`, insertionPoint: { x: 0, y }, textHeight: 0.2, rotation: 0
    }, {
      type: 'TEXT', kind: 'text', handle: `Q-${row}`, layer: 'LARGE_BOM',
      text: row === 0 ? 'Quantity' : String(row), insertionPoint: { x: 20, y }, textHeight: 0.2, rotation: 0
    });
  }
  const bom = extractCadBom(cadDocument({ entities }), {
    sources: ['text-table'], textTables: true, maxRows: 20, maxCells: 12_000
  });
  const table = tableBySource(bom, 'text-table');

  assert.equal(table.rows.length, 20);
  assert.ok(table.warnings.some((warning) => warning.code === 'max-rows'));
  assert.ok(bom.warnings.some((warning) => warning.code === 'max-rows' && warning.source === 'text-table'));
});

test('anonymous dynamic blocks remain in the default BOM and quantities saturate safely', () => {
  const bom = extractCadBom(cadDocument({
    entities: [{
      type: 'INSERT', kind: 'insert', handle: 'DYN-1', blockName: '*U123',
      insertRowCount: Number.MAX_SAFE_INTEGER, insertColumnCount: 2
    }, {
      type: 'INSERT', kind: 'insert', handle: 'DYN-2', blockName: '*U123',
      insertRowCount: Number.MAX_SAFE_INTEGER, insertColumnCount: 2
    }, {
      type: 'INSERT', kind: 'insert', handle: 'ANON-1', blockName: '*D1'
    }]
  }), { sources: ['block-attributes'], recursiveBlocks: false });
  const table = tableBySource(bom, 'block-attributes');

  assert.deepEqual(table.rows.map((row) => row.cells.item), ['*U123']);
  assert.equal(table.rows[0].quantity, Number.MAX_SAFE_INTEGER);
  assert.equal(bom.summary.blockQuantity, Number.MAX_SAFE_INTEGER);
  assert.ok(Number.isSafeInteger(bom.summary.blockQuantity));
});

test('CSV/JSON export is deterministic, RFC 4180 quoted, UTF-8 BOM prefixed and formula-safe', () => {
  const bom = extractCadBom(cadDocument({
    dataTables: [{
      handle: 'CSV',
      name: 'Export',
      rowCount: 1,
      columnCount: 3,
      columns: [
        { name: 'Part', values: ['P-1'] },
        { name: 'Note', values: ['Bolt, "M8"\nleft'] },
        { name: 'Formula', values: ['=2+3'] }
      ]
    }]
  }), { sources: ['data-table'] });

  assert.equal(
    serializeCadBomCsv(bom),
    '\uFEFFPart,Note,Formula\r\nP-1,"Bolt, ""M8""\nleft",\'=2+3'
  );
  assert.equal(
    serializeCadBomCsv(bom, { includeUtf8Bom: false, delimiter: ';', lineEnding: '\n', escapeFormulas: false }),
    'Part;Note;Formula\nP-1;"Bolt, ""M8""\nleft";=2+3'
  );
  const json = serializeCadBomJson(bom);
  assert.ok(json.includes('\n  "schemaVersion": 1'));
  assert.deepEqual(JSON.parse(json), bom);
});

test('JSON export redacts DataLink connection strings unless sensitive output is explicitly requested', () => {
  const bom = extractCadBom(cadDocument({
    dataLinks: [{ handle: 'DL-PRIVATE', connectionString: 'file:///Users/customer/private-parts.xlsx', description: 'Parts' }],
    entities: [{
      type: 'ACAD_TABLE', kind: 'table', handle: 'T-PRIVATE',
      table: {
        rowCount: 2, columnCount: 2, headerSuppressed: false, dataLinkHandle: 'DL-PRIVATE',
        cells: [
          { row: 0, column: 0, text: 'Part' }, { row: 0, column: 1, text: 'Quantity' },
          { row: 1, column: 0, text: 'P-1' }, { row: 1, column: 1, text: '2' }
        ]
      }
    }]
  }), { sources: ['native-table'] });

  const safe = JSON.parse(serializeCadBomJson(bom, { pretty: false }));
  assert.equal(safe.tables[0].dataLink.connectionString, undefined);
  assert.equal(safe.tables[0].dataLink.description, 'Parts');
  const sensitive = JSON.parse(serializeCadBomJson(bom, { pretty: false, includeSensitiveData: true }));
  assert.equal(sensitive.tables[0].dataLink.connectionString, 'file:///Users/customer/private-parts.xlsx');
  assert.equal(bom.tables[0].dataLink.connectionString, 'file:///Users/customer/private-parts.xlsx', 'serialization does not mutate the BOM');
});

test('unsupported native formats return an empty, structured warning instead of guessing a BOM', () => {
  const bom = extractCadBom(cadDocument({ format: 'dwf', sourceName: 'drawing.dwf' }));
  assert.equal(bom.tables.length, 0);
  assert.deepEqual(bom.warnings.map((warning) => warning.code), ['unsupported-format']);
});

test('ASCII DXF supplement restores ATTRIB, XDATA, ACAD_TABLE, DATATABLE, DATALINK and dictionary XRECORD data skipped by dxf-parser', async () => {
  const dxf = `0
SECTION
2
HEADER
0
ENDSEC
0
SECTION
2
TABLES
0
ENDSEC
0
SECTION
2
BLOCKS
0
BLOCK
5
B0
2
PART
3
PART
10
0
20
0
30
0
0
ATTDEF
5
AD1
100
AcDbEntity
8
0
100
AcDbText
10
0
20
0
30
0
40
1
1
STEEL
100
AcDbAttributeDefinition
2
MATERIAL
3
Material
70
2
0
ENDBLK
0
ENDSEC
0
SECTION
2
ENTITIES
0
INSERT
5
I1
100
AcDbEntity
8
EQUIPMENT
100
AcDbBlockReference
2
PART
10
0
20
0
30
0
66
1
70
2
71
3
1001
BOM_XDATA
1000
ERP=10042
1070
6
0
ATTRIB
5
A1
330
I1
100
AcDbEntity
8
EQUIPMENT
100
AcDbText
10
0
20
0
30
0
40
1
1
P-100
100
AcDbAttribute
2
PART_NO
70
0
0
SEQEND
5
S1
0
ACAD_TABLE
5
T1
100
AcDbEntity
8
BOM
100
AcDbBlockReference
2
*T1
10
0
20
0
30
0
100
AcDbTable
280
0
91
2
92
2
141
4
141
4
142
20
142
10
171
1
302
Part
171
1
302
Quantity
171
1
302
P-100
171
1
302
6
0
ENDSEC
0
SECTION
2
OBJECTS
0
DICTIONARY
5
D0
100
AcDbDictionary
3
SCHEDULES
350
D1
0
DICTIONARY
5
D1
330
D0
100
AcDbDictionary
3
PARTS
350
XR1
0
XRECORD
5
XR1
330
D1
100
AcDbXrecord
280
1
1
Cached BOM metadata
90
42
0
DATALINK
5
DL1
100
AcDbDataLink
1
AcExcel
300
Parts workbook
301
Cached only
302
file:///private/customer/parts.xlsx
90
2
91
1
177
1
304
stale
0
DATATABLE
5
DT1
100
AcDbDataTable
70
0
90
2
91
2
1
Cached parts
92
3
2
Part
3
P-1
3
P-2
92
1
2
Quantity
93
2
93
8
0
ENDSEC
0
EOF
`;
  const loader = new DxfLoader();
  const result = await loader.load({ fileName: 'bom-supplement.dxf', buffer: new TextEncoder().encode(dxf) });
  const insert = result.document.entities.find((entity) => entity.handle === 'I1');
  assert.equal(insert?.attribs?.[0]?.attributeTag, 'PART_NO');
  assert.equal(insert?.attribs?.[0]?.text, 'P-100');
  assert.deepEqual(insert?.xdata?.[0], {
    appName: 'BOM_XDATA',
    entries: [{ code: 1000, value: 'ERP=10042' }, { code: 1070, value: 6 }]
  });
  assert.equal(result.document.dataLinks?.[0]?.connectionString, 'file:///private/customer/parts.xlsx');
  assert.deepEqual(result.document.dataTables?.[0]?.columns.map((column) => column.values), [['P-1', 'P-2'], [2, 8]]);
  assert.deepEqual(result.document.xrecords?.[0]?.dictionaryPath, ['SCHEDULES', 'PARTS']);

  const bom = extractCadBom(result.document, {
    sources: ['block-attributes', 'native-table', 'data-table', 'xdata', 'xrecord'],
    recursiveBlocks: false
  });
  assert.equal(tableBySource(bom, 'block-attributes').rows[0].quantity, 6);
  assert.equal(tableBySource(bom, 'block-attributes').rows[0].cells.part_no, 'P-100');
  assert.equal(tableBySource(bom, 'block-attributes').rows[0].cells.material, 'STEEL');
  assert.deepEqual(tableBySource(bom, 'native-table').rows[0].cells, { part: 'P-100', quantity: 6 });
  assert.deepEqual(tableBySource(bom, 'data-table').rows.map((row) => row.cells), [
    { part: 'P-1', quantity: 2 },
    { part: 'P-2', quantity: 8 }
  ]);
  assert.equal(tableBySource(bom, 'xdata').rows[0].cells['1000'], 'ERP=10042');
  assert.equal(tableBySource(bom, 'xrecord').name, 'SCHEDULES / PARTS');
});

test('handleless R12 DXF associates sequential ATTRIB and XDATA records with the correct INSERT', async () => {
  const dxf = `0
SECTION
2
HEADER
9
$ACADVER
1
AC1009
0
ENDSEC
0
SECTION
2
BLOCKS
0
BLOCK
8
0
2
PART
70
0
10
0
20
0
30
0
3
PART
1

0
ATTDEF
8
0
10
0
20
0
30
0
40
1
1
DEFAULT
3
Part number
2
PART_NO
70
0
0
ENDBLK
0
ENDSEC
0
SECTION
2
ENTITIES
0
INSERT
8
EQUIPMENT
2
PART
10
0
20
0
30
0
66
1
1001
BOM_APP
1000
ERP=FIRST
0
ATTRIB
8
EQUIPMENT
10
0
20
0
30
0
40
1
1
P-001
2
PART_NO
70
0
0
SEQEND
0
INSERT
8
EQUIPMENT
2
PART
10
10
20
0
30
0
66
1
1001
BOM_APP
1000
ERP=SECOND
0
ATTRIB
8
EQUIPMENT
10
10
20
0
30
0
40
1
1
P-002
2
PART_NO
70
0
0
SEQEND
0
ENDSEC
0
EOF
`;
  const result = await new DxfLoader().load({ fileName: 'r12-handleless.dxf', buffer: new TextEncoder().encode(dxf) });
  const inserts = result.document.entities.filter((entity) => entity.kind === 'insert');

  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts.map((entity) => entity.attribs?.[0]?.text), ['P-001', 'P-002']);
  assert.deepEqual(inserts.map((entity) => entity.xdata?.[0]?.entries[0]?.value), ['ERP=FIRST', 'ERP=SECOND']);
  assert.ok(!result.document.warnings.some((warning) => warning.includes('could not be matched')));

  const bom = extractCadBom(result.document, { sources: ['block-attributes', 'xdata'], recursiveBlocks: false });
  assert.deepEqual(tableBySource(bom, 'block-attributes').rows.map((row) => row.cells.part_no), ['P-001', 'P-002']);
  assert.deepEqual(tableBySource(bom, 'xdata').rows.map((row) => row.cells['1000']), ['ERP=FIRST', 'ERP=SECOND']);
});
