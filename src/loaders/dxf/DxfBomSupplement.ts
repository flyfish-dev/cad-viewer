import { normalizeCadEntity, stringOrUndefined } from '../../core/entity';
import type {
  CadDataLink,
  CadDataTable,
  CadDataTableColumn,
  CadDataValue,
  CadDictionary,
  CadDocument,
  CadEntity,
  CadPoint3D,
  CadTableCell,
  CadXData,
  CadXDataEntry,
  CadXRecord
} from '../../core/types';

interface DxfPair {
  code: number;
  value: string;
}

interface DxfRecord {
  section: string;
  blockName?: string;
  type: string;
  pairs: DxfPair[];
}

interface DxfEntityLocator {
  context: string;
  type: string;
  ordinal: number;
}

interface DxfAttributeAttachment {
  ownerHandle?: string;
  ownerLocator?: DxfEntityLocator;
  attribute: CadEntity;
}

interface DxfLocatedXData {
  handle?: string;
  locator: DxfEntityLocator;
  groups: CadXData[];
}

const MAX_DXF_BOM_TEXT_CHARS = 128 * 1024 * 1024;
const MAX_DXF_BOM_PAIRS = 2_000_000;
const MAX_DXF_BOM_RECORDS = 500_000;
const MAX_DXF_PAIR_VALUE_CHARS = 1_048_576;
const MAX_XDATA_GROUPS_PER_ENTITY = 256;
const MAX_XDATA_ENTRIES_PER_ENTITY = 20_000;
const MAX_XRECORD_VALUES = 100_000;

export interface DxfBomSupplement {
  attributes: DxfAttributeAttachment[];
  xdataByHandle: Map<string, CadXData[]>;
  xdataByLocator: DxfLocatedXData[];
  tables: Array<{ blockName?: string; locator?: DxfEntityLocator; entity: CadEntity }>;
  dictionaries: CadDictionary[];
  xrecords: CadXRecord[];
  dataLinks: CadDataLink[];
  dataTables: CadDataTable[];
  warnings: string[];
}

/**
 * Reads the business-data records which dxf-parser intentionally skips.
 *
 * This pass is deliberately independent from geometry parsing: ATTRIB,
 * ACAD_TABLE and OBJECTS records must not disappear merely because an
 * otherwise-valid entity type is unknown to the drawing renderer.
 */
export function parseDxfBomSupplement(text: string): DxfBomSupplement {
  const warnings: string[] = [];
  const records = splitDxfRecords(parseDxfPairs(text, warnings), warnings);
  const attributes: DxfAttributeAttachment[] = [];
  const xdataByHandle = new Map<string, CadXData[]>();
  const xdataByLocator: DxfLocatedXData[] = [];
  const tables: Array<{ blockName?: string; locator?: DxfEntityLocator; entity: CadEntity }> = [];
  const dictionaries: CadDictionary[] = [];
  const xrecords: CadXRecord[] = [];
  const dataLinks: CadDataLink[] = [];
  const dataTables: CadDataTable[] = [];
  let pendingInsertHandle: string | undefined;
  let pendingInsertLocator: DxfEntityLocator | undefined;
  let pendingContext = '';
  const locatorCounters = new Map<string, number>();

  for (const record of records) {
    const context = canonicalContext(record.section, record.blockName);
    const locator = createRecordLocator(record, context, locatorCounters);
    const handle = readHandle(record.pairs, 5) ?? readHandle(record.pairs, 105);
    const xdata = parseXData(record.pairs, warnings, `${record.type}${handle ? ` ${handle}` : ''}`);
    if (handle && xdata.length > 0) xdataByHandle.set(canonicalHandle(handle), xdata);
    if (locator && xdata.length > 0) xdataByLocator.push({ handle, locator, groups: xdata });

    if (record.section === 'ENTITIES' || record.section === 'BLOCKS') {
      if (record.type === 'INSERT' || record.type === 'MINSERT') {
        // ATTRIB/SEQEND records immediately follow their INSERT. Group 330
        // commonly points at the containing BLOCK_RECORD, not the INSERT.
        pendingInsertHandle = handle;
        pendingInsertLocator = locator;
        pendingContext = context;
      } else if (record.type === 'ATTRIB') {
        const ownerHandle = context === pendingContext && pendingInsertHandle
          ? pendingInsertHandle
          : readEntityOwner(record.pairs);
        const ownerLocator = context === pendingContext ? pendingInsertLocator : undefined;
        attributes.push({ ownerHandle, ownerLocator, attribute: parseAttribute(record, xdata) });
      } else if (record.type === 'SEQEND') {
        pendingInsertHandle = undefined;
        pendingInsertLocator = undefined;
      } else {
        pendingInsertHandle = undefined;
        pendingInsertLocator = undefined;
      }

      if (record.type === 'ACAD_TABLE' || record.type === 'TABLE') {
        tables.push({ blockName: record.blockName, locator, entity: parseLegacyTable(record, xdata) });
      }
      continue;
    }

    if (record.section !== 'OBJECTS') continue;
    switch (record.type) {
      case 'DICTIONARY':
      case 'ACDBDICTIONARYWDFLT':
        dictionaries.push(parseDictionary(record));
        break;
      case 'XRECORD':
        xrecords.push(parseXRecord(record, warnings));
        break;
      case 'DATALINK':
        dataLinks.push(parseDataLink(record));
        break;
      case 'DATATABLE':
        dataTables.push(parseDataTable(record));
        break;
      case 'TABLECONTENT': {
        const dataTable = parseLinkedTableContent(record);
        if (dataTable) dataTables.push(dataTable);
        break;
      }
    }
  }

  resolveXRecordNames(dictionaries, xrecords);
  return { attributes, xdataByHandle, xdataByLocator, tables, dictionaries, xrecords, dataLinks, dataTables, warnings };
}

export function applyDxfBomSupplement(document: CadDocument, supplement: DxfBomSupplement): void {
  const entitiesByHandle = new Map<string, CadEntity>();
  const entitiesByLocator = new Map<string, CadEntity>();
  const allBlocks = new Set(Object.values(document.blocks));
  indexEntityContext(document.entities, canonicalContext('ENTITIES'), entitiesByHandle, entitiesByLocator);
  for (const block of allBlocks) indexEntityContext(block.entities, canonicalContext('BLOCKS', block.name), entitiesByHandle, entitiesByLocator);

  for (const { ownerHandle, ownerLocator, attribute } of supplement.attributes) {
    const owner = (ownerHandle ? entitiesByHandle.get(canonicalHandle(ownerHandle)) : undefined)
      ?? (ownerLocator ? entitiesByLocator.get(locatorKey(ownerLocator)) : undefined);
    if (!owner || (owner.kind !== 'insert' && !/^(INSERT|MINSERT)$/i.test(owner.type))) {
      document.warnings.push(`DXF ATTRIB ${attribute.handle ?? attribute.attributeTag ?? '(unknown)'} could not be matched to its INSERT${ownerHandle ? ` ${ownerHandle}` : ''}.`);
      continue;
    }
    const attributes = owner.attribs ?? (owner.attribs = []);
    if (!attributes.some((candidate) => sameAttribute(candidate, attribute))) attributes.push(attribute);
  }

  for (const [handle, groups] of supplement.xdataByHandle) {
    const entity = entitiesByHandle.get(handle);
    if (entity) entity.xdata = groups;
  }
  for (const { handle, locator, groups } of supplement.xdataByLocator) {
    const entity = entitiesByLocator.get(locatorKey(locator));
    if (entity) entity.xdata = groups;
    else if (handle && entitiesByHandle.has(canonicalHandle(handle))) continue;
    else document.warnings.push(`DXF XDATA on ${handle ? `${locator.type} ${handle}` : `handleless ${locator.type} #${locator.ordinal + 1}`} could not be matched to a normalized entity.`);
  }

  for (const { blockName, locator, entity } of supplement.tables) {
    const existing = (entity.handle ? entitiesByHandle.get(canonicalHandle(entity.handle)) : undefined)
      ?? (locator ? entitiesByLocator.get(locatorKey(locator)) : undefined);
    if (existing) {
      existing.kind = 'table';
      existing.table = entity.table;
      existing.xdata = entity.xdata ?? existing.xdata;
      continue;
    }
    if (blockName) {
      const block = document.blocks[blockName] ?? document.blocks[blockName.toLocaleLowerCase()];
      if (block) block.entities.push(entity);
      else document.warnings.push(`DXF table ${entity.handle ?? '(unknown)'} belongs to missing block ${blockName}.`);
    } else {
      document.entities.push(entity);
    }
    indexEntity(entity, entitiesByHandle);
  }

  if (supplement.dictionaries.length > 0) document.dictionaries = mergeByHandle(document.dictionaries, supplement.dictionaries);
  if (supplement.xrecords.length > 0) document.xrecords = mergeByHandle(document.xrecords, supplement.xrecords);
  if (supplement.dataLinks.length > 0) document.dataLinks = mergeByHandle(document.dataLinks, supplement.dataLinks);
  if (supplement.dataTables.length > 0) document.dataTables = mergeByHandle(document.dataTables, supplement.dataTables);
  document.warnings.push(...supplement.warnings);
  document.metadata.dxfBusinessData = {
    attributes: supplement.attributes.length,
    nativeTables: supplement.tables.length,
    dataTables: supplement.dataTables.length,
    dataLinks: supplement.dataLinks.length,
    xrecords: supplement.xrecords.length
  };
}

function parseDxfPairs(text: string, warnings: string[]): DxfPair[] {
  const sourceLength = Math.min(text.length, MAX_DXF_BOM_TEXT_CHARS);
  if (text.length > sourceLength) {
    warnings.push(`DXF BOM metadata scan was capped at ${MAX_DXF_BOM_TEXT_CHARS.toLocaleString()} characters.`);
  }
  const pairs: DxfPair[] = [];
  let offset = 0;
  let truncatedValue = false;
  const nextLine = (): string | undefined => {
    if (offset >= sourceLength) return undefined;
    const start = offset;
    while (offset < sourceLength && text.charCodeAt(offset) !== 10 && text.charCodeAt(offset) !== 13) offset += 1;
    const line = text.slice(start, offset);
    if (offset < sourceLength && text.charCodeAt(offset) === 13) offset += 1;
    if (offset < sourceLength && text.charCodeAt(offset) === 10) offset += 1;
    return line;
  };
  while (pairs.length < MAX_DXF_BOM_PAIRS) {
    const codeLine = nextLine();
    const rawValue = nextLine();
    if (codeLine === undefined || rawValue === undefined) break;
    const code = Number(codeLine.trim());
    if (!Number.isInteger(code)) continue;
    const value = rawValue.length > MAX_DXF_PAIR_VALUE_CHARS
      ? rawValue.slice(0, MAX_DXF_PAIR_VALUE_CHARS)
      : rawValue;
    if (value.length !== rawValue.length) truncatedValue = true;
    pairs.push({ code, value: value.trimEnd() });
  }
  if (pairs.length >= MAX_DXF_BOM_PAIRS && offset < sourceLength) {
    warnings.push(`DXF BOM metadata scan was capped at ${MAX_DXF_BOM_PAIRS.toLocaleString()} group-code pairs.`);
  }
  if (truncatedValue) warnings.push(`One or more DXF metadata values were capped at ${MAX_DXF_PAIR_VALUE_CHARS.toLocaleString()} characters.`);
  return pairs;
}

function splitDxfRecords(pairs: DxfPair[], warnings: string[]): DxfRecord[] {
  const records: DxfRecord[] = [];
  let section = '';
  let current: DxfPair[] = [];
  let recordLimitReached = false;
  const flush = (): void => {
    if (current.length === 0 || section === '') {
      current = [];
      return;
    }
    if (records.length < MAX_DXF_BOM_RECORDS) records.push({ section, type: current[0].value.trim().toUpperCase(), pairs: current });
    else recordLimitReached = true;
    current = [];
  };

  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair.code === 0 && pair.value.trim().toUpperCase() === 'SECTION') {
      flush();
      const name = pairs[index + 1];
      section = name?.code === 2 ? name.value.trim().toUpperCase() : '';
      if (name?.code === 2) index += 1;
      continue;
    }
    if (pair.code === 0 && pair.value.trim().toUpperCase() === 'ENDSEC') {
      flush();
      section = '';
      continue;
    }
    if (!section) continue;
    if (pair.code === 0) flush();
    current.push(pair);
  }
  flush();
  if (recordLimitReached) warnings.push(`DXF BOM metadata scan was capped at ${MAX_DXF_BOM_RECORDS.toLocaleString()} records.`);

  let blockName: string | undefined;
  for (const record of records) {
    if (record.section !== 'BLOCKS') continue;
    if (record.type === 'BLOCK') {
      blockName = readString(record.pairs, 2) ?? readString(record.pairs, 3);
      record.blockName = blockName;
    } else if (record.type === 'ENDBLK') {
      record.blockName = blockName;
      blockName = undefined;
    } else {
      record.blockName = blockName;
    }
  }
  return records;
}

function parseAttribute(record: DxfRecord, xdata: CadXData[]): CadEntity {
  const raw: Record<string, unknown> = {
    type: 'ATTRIB',
    handle: readHandle(record.pairs, 5),
    layer: readString(record.pairs, 8) ?? '0',
    text: decodeCadText(readJoined(record.pairs, [3, 1])),
    tag: decodeCadText(readString(record.pairs, 2)),
    prompt: decodeCadText(readString(record.pairs, 3)),
    attributeFlags: readNumber(record.pairs, 70),
    insertionPoint: readPoint(record.pairs, 10),
    textHeight: readNumber(record.pairs, 40),
    rotation: degreesToRadians(readNumber(record.pairs, 50)),
    isVisible: readNumber(record.pairs, 60) !== 1,
    xdata
  };
  return normalizeCadEntity(raw, 'ATTRIB', { includeUnknownProperties: false });
}

function parseLegacyTable(record: DxfRecord, xdata: CadXData[]): CadEntity {
  const tablePairs = pairsAfterSubclass(record.pairs, 'AcDbTable');
  const rowCount = boundedCount(readNumber(tablePairs, 91), 5000);
  const columnCount = boundedCount(readNumber(tablePairs, 92), 5000);
  const expectedCells = Math.min(1_000_000, rowCount * columnCount);
  const starts: number[] = [];
  for (let index = 0; index < tablePairs.length; index += 1) if (tablePairs[index].code === 171) starts.push(index);
  const cells: CadTableCell[] = [];
  if (starts.length > 0) {
    for (let cellIndex = 0; cellIndex < Math.min(expectedCells || starts.length, starts.length); cellIndex += 1) {
      const slice = tablePairs.slice(starts[cellIndex], starts[cellIndex + 1] ?? tablePairs.length);
      const text = readTableCellText(slice);
      cells.push({
        row: columnCount > 0 ? Math.floor(cellIndex / columnCount) : cellIndex,
        column: columnCount > 0 ? cellIndex % columnCount : 0,
        text,
        dataType: readNumber(slice, 171),
        formula: decodeCadText(readString(slice, 300)),
        isMerged: readNumber(slice, 173) === 1,
        blockTableRecordId: readHandle(slice, 340)
      });
    }
  }

  const raw = {
    type: 'ACAD_TABLE',
    handle: readHandle(record.pairs, 5),
    layer: readString(record.pairs, 8) ?? '0',
    insertionPoint: readPoint(record.pairs, 10),
    blockName: readString(pairsAfterSubclass(record.pairs, 'AcDbBlockReference'), 2),
    rowCount,
    columnCount,
    rowHeights: readNumbers(tablePairs, 141).slice(0, rowCount),
    columnWidths: readNumbers(tablePairs, 142).slice(0, columnCount),
    cells,
    xdata
  };
  return normalizeCadEntity(raw, 'ACAD_TABLE', { includeUnknownProperties: false });
}

function parseDictionary(record: DxfRecord): CadDictionary {
  const entries: CadDictionary['entries'] = [];
  for (let index = 0; index < record.pairs.length; index += 1) {
    if (record.pairs[index].code !== 3) continue;
    const handlePair = record.pairs.slice(index + 1).find((pair) => pair.code === 350 || pair.code === 360 || pair.code === 3);
    if (handlePair && handlePair.code !== 3 && handlePair.value) entries.push({ name: decodeCadText(record.pairs[index].value) ?? record.pairs[index].value, handle: handlePair.value });
  }
  return {
    handle: readHandle(record.pairs, 5) ?? readHandle(record.pairs, 105),
    ownerHandle: readObjectOwner(record.pairs),
    entries
  };
}

function parseXRecord(record: DxfRecord, warnings: string[]): CadXRecord {
  const dataPairs = pairsAfterSubclass(record.pairs, 'AcDbXrecord');
  const cloningIndex = dataPairs.findIndex((pair) => pair.code === 280);
  const valuePairs = dataPairs.filter((_, index) => index !== cloningIndex);
  if (valuePairs.length > MAX_XRECORD_VALUES) {
    warnings.push(`DXF XRECORD ${readHandle(record.pairs, 5) ?? '(handleless)'} was capped at ${MAX_XRECORD_VALUES.toLocaleString()} values.`);
  }
  return {
    handle: readHandle(record.pairs, 5) ?? readHandle(record.pairs, 105),
    ownerHandle: readObjectOwner(record.pairs),
    cloning: readNumber(dataPairs, 280),
    data: valuePairs
      // Once AcDbXrecord starts, handle-valued groups are application data.
      // Only the first 280 group is the XRECORD cloning flag.
      .slice(0, MAX_XRECORD_VALUES)
      .map((pair) => ({ code: pair.code, value: dxfValue(pair) }))
  };
}

function parseDataLink(record: DxfRecord): CadDataLink {
  const pairs = pairsAfterSubclass(record.pairs, 'AcDbDataLink');
  const year = readNumber(pairs, 170);
  const month = readNumber(pairs, 171);
  const day = readNumber(pairs, 172);
  const hour = readNumber(pairs, 173) ?? 0;
  const minute = readNumber(pairs, 174) ?? 0;
  const second = readNumber(pairs, 175) ?? 0;
  const millisecond = readNumber(pairs, 176) ?? 0;
  const lastUpdated = year && month && day
    ? safeIsoDate(year, month, day, hour, minute, second, millisecond)
    : undefined;
  return {
    handle: readHandle(record.pairs, 5) ?? readHandle(record.pairs, 105),
    dataAdapter: decodeCadText(readString(pairs, 1)),
    description: decodeCadText(readString(pairs, 300)),
    tooltip: decodeCadText(readString(pairs, 301)),
    connectionString: decodeCadText(readString(pairs, 302)),
    updateOption: readNumber(pairs, 91),
    pathOption: readNumber(pairs, 177),
    updateStatus: decodeCadText(readString(pairs, 304)),
    lastUpdated
  };
}

function parseDataTable(record: DxfRecord): CadDataTable {
  const pairs = pairsAfterSubclass(record.pairs, 'AcDbDataTable', 'ACDBDATATABLE');
  const columnCount = boundedCount(readNumber(pairs, 90), 100_000);
  const rowCount = boundedCount(readNumber(pairs, 91), 1_000_000);
  const columns: CadDataTableColumn[] = [];
  const starts: number[] = [];
  for (let index = 0; index < pairs.length; index += 1) if (pairs[index].code === 92) starts.push(index);
  for (let index = 0; index < Math.min(columnCount || starts.length, starts.length); index += 1) {
    const slice = pairs.slice(starts[index], starts[index + 1] ?? pairs.length);
    const name = decodeCadText(readString(slice, 2)) ?? `Column ${index + 1}`;
    const nameIndex = slice.findIndex((pair) => pair.code === 2);
    const decodedValues = readDataTableValues(slice.slice(nameIndex + 1));
    const values = rowCount > 0 ? decodedValues.slice(0, rowCount) : decodedValues;
    columns.push({ name, type: readNumber(slice, 92), values });
  }
  return {
    handle: readHandle(record.pairs, 5) ?? readHandle(record.pairs, 105),
    name: decodeCadText(readString(pairs, 1)),
    rowCount: rowCount || Math.max(0, ...columns.map((column) => column.values.length)),
    columnCount: columnCount || columns.length,
    columns
  };
}

/**
 * Modern DXF TABLECONTENT is marker-based and extensible. This conservative
 * reader extracts cached VALUE blocks and their declared row/column counts;
 * unknown formatting/custom-data records remain ignored rather than guessed.
 */
function parseLinkedTableContent(record: DxfRecord): CadDataTable | undefined {
  const pairs = pairsAfterSubclass(record.pairs, 'AcDbLinkedTableData');
  if (pairs.length === 0) return undefined;
  const name = decodeCadText(readString(pairsAfterSubclass(record.pairs, 'AcDbLinkedData'), 1));
  const values: CadDataValue[] = [];
  for (let index = 0; index < pairs.length; index += 1) {
    if (pairs[index].code !== 300 || pairs[index].value.trim().toUpperCase() !== 'VALUE') continue;
    const end = findMarkerEnd(pairs, index + 1, ['CELLCONTENT_END', 'FORMATTEDCELLCONTENT_BEGIN']);
    const value = firstStructuredValue(pairs.slice(index + 1, end));
    values.push(value ?? '');
    index = Math.max(index, end - 1);
  }
  if (values.length === 0) return undefined;

  const columns = readLinkedColumnNames(pairs);
  const columnCount = Math.max(1, columns.length || inferLinkedColumnCount(pairs, values.length));
  const rowCount = Math.max(1, Math.ceil(values.length / columnCount));
  const normalizedColumns: CadDataTableColumn[] = Array.from({ length: columnCount }, (_, column) => ({
    name: columns[column] ?? `Column ${column + 1}`,
    values: Array.from({ length: rowCount }, (_, row) => values[row * columnCount + column] ?? '')
  }));
  return {
    handle: readHandle(record.pairs, 5) ?? readHandle(record.pairs, 105),
    name,
    rowCount,
    columnCount,
    columns: normalizedColumns
  };
}

function parseXData(pairs: DxfPair[], warnings: string[], label: string): CadXData[] {
  const groups: CadXData[] = [];
  let current: CadXData | undefined;
  let entries = 0;
  let truncated = false;
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair.code === 1001) {
      if (groups.length >= MAX_XDATA_GROUPS_PER_ENTITY) {
        current = undefined;
        truncated = true;
        continue;
      }
      current = { appName: decodeCadText(pair.value) ?? pair.value, entries: [] };
      groups.push(current);
    } else if (current && pair.code >= 1000 && pair.code <= 1071) {
      if (entries >= MAX_XDATA_ENTRIES_PER_ENTITY) {
        truncated = true;
        continue;
      }
      let value = dxfValue(pair);
      if (pair.code >= 1010 && pair.code <= 1013) {
        const yPair = pairs[index + 1]?.code === pair.code + 10 ? pairs[index + 1] : undefined;
        const zPair = pairs[index + (yPair ? 2 : 1)]?.code === pair.code + 20 ? pairs[index + (yPair ? 2 : 1)] : undefined;
        const x = Number(pair.value);
        const y = Number(yPair?.value);
        const z = Number(zPair?.value);
        if (Number.isFinite(x) && Number.isFinite(y)) value = Number.isFinite(z) ? { x, y, z } : { x, y };
        if (yPair) index += 1;
        if (zPair) index += 1;
      }
      const entry: CadXDataEntry = { code: pair.code, value };
      current.entries.push(entry);
      entries += 1;
    }
  }
  if (truncated) warnings.push(`DXF XDATA on ${label} exceeded its safe metadata limit and was truncated.`);
  return groups.filter((group) => group.entries.length > 0);
}

function resolveXRecordNames(dictionaries: CadDictionary[], records: CadXRecord[]): void {
  const dictionariesByHandle = new Map<string, CadDictionary>();
  const entryByHandle = new Map<string, { name: string; dictionary: CadDictionary }>();
  for (const dictionary of dictionaries) {
    if (dictionary.handle) dictionariesByHandle.set(canonicalHandle(dictionary.handle), dictionary);
    for (const entry of dictionary.entries) entryByHandle.set(canonicalHandle(entry.handle), { name: entry.name, dictionary });
  }
  for (const record of records) {
    if (!record.handle) continue;
    const entry = entryByHandle.get(canonicalHandle(record.handle));
    if (!entry) continue;
    record.entryName = entry.name;
    const path = [entry.name];
    let dictionary: CadDictionary | undefined = entry.dictionary;
    const seen = new Set<string>();
    while (dictionary?.handle && !seen.has(canonicalHandle(dictionary.handle))) {
      seen.add(canonicalHandle(dictionary.handle));
      const parentEntry = entryByHandle.get(canonicalHandle(dictionary.handle));
      if (!parentEntry) break;
      path.unshift(parentEntry.name);
      dictionary = dictionariesByHandle.get(canonicalHandle(parentEntry.dictionary.handle ?? ''));
    }
    record.dictionaryPath = path;
  }
}

function readDataTableValues(pairs: DxfPair[]): CadDataValue[] {
  const values: CadDataValue[] = [];
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair.code === 71) values.push(pair.value.trim() !== '0');
    else if (pair.code === 93 || pair.code === 40) values.push(numberValue(pair.value));
    else if (pair.code === 3) values.push(decodeCadText(pair.value) ?? pair.value);
    else if ([331, 360, 350, 340, 330].includes(pair.code)) values.push(pair.value);
    else if (pair.code === 10 || pair.code === 11) {
      const yPair = pairs[index + 1]?.code === pair.code + 10 ? pairs[index + 1] : undefined;
      const zPair = pairs[index + (yPair ? 2 : 1)]?.code === pair.code + 20 ? pairs[index + (yPair ? 2 : 1)] : undefined;
      const x = Number(pair.value);
      const y = Number(yPair?.value);
      const z = Number(zPair?.value);
      if (Number.isFinite(x) && Number.isFinite(y)) values.push(Number.isFinite(z) ? { x, y, z } : { x, y });
      if (yPair) index += 1;
      if (zPair) index += 1;
    }
  }
  return values;
}

function readLinkedColumnNames(pairs: DxfPair[]): string[] {
  const names: string[] = [];
  for (let index = 0; index < pairs.length - 1; index += 1) {
    if (pairs[index].code !== 300) continue;
    const next = pairs[index + 1];
    if (next.code === 1 && next.value.trim().toUpperCase() === 'LINKEDTABLEDATACOLUMN_BEGIN') {
      names.push(decodeCadText(pairs[index].value) ?? pairs[index].value);
    }
  }
  return names;
}

function inferLinkedColumnCount(pairs: DxfPair[], valueCount: number): number {
  const declared = pairs.find((pair, index) => pair.code === 90 && pairs[index - 1]?.value !== 'VALUE');
  const count = boundedCount(declared ? Number(declared.value) : undefined, 100_000);
  return count > 0 ? Math.min(count, Math.max(1, valueCount)) : 1;
}

function firstStructuredValue(pairs: DxfPair[]): CadDataValue | undefined {
  for (const pair of pairs) {
    if (pair.code === 300 && /^(VALUE|CONTENTFORMAT|CELLCONTENT)/i.test(pair.value)) continue;
    if ([1, 2, 3, 300, 301, 302, 303, 304].includes(pair.code)) return decodeCadText(pair.value) ?? pair.value;
    if ((pair.code >= 10 && pair.code <= 59) || (pair.code >= 90 && pair.code <= 99) || (pair.code >= 170 && pair.code <= 179) || (pair.code >= 270 && pair.code <= 299)) return numberValue(pair.value);
    if (pair.code >= 310 && pair.code <= 369) return pair.value;
  }
  return undefined;
}

function findMarkerEnd(pairs: DxfPair[], start: number, markers: string[]): number {
  const wanted = new Set(markers.map((marker) => marker.toUpperCase()));
  for (let index = start; index < pairs.length; index += 1) if (wanted.has(pairs[index].value.trim().toUpperCase())) return index;
  return pairs.length;
}

function readTableCellText(pairs: DxfPair[]): string {
  const short = pairs.filter((pair) => pair.code === 302).map((pair) => pair.value);
  const chunks = pairs.filter((pair) => pair.code === 303 || pair.code === 1).map((pair) => pair.value);
  return decodeCadText((chunks.length > 0 ? chunks : short).join('')) ?? '';
}

function pairsAfterSubclass(pairs: DxfPair[], ...names: string[]): DxfPair[] {
  const targets = new Set(names.map((name) => name.toUpperCase()));
  let start = -1;
  for (let index = 0; index < pairs.length; index += 1) {
    if (pairs[index].code === 100 && targets.has(pairs[index].value.trim().toUpperCase())) start = index + 1;
  }
  return start >= 0 ? pairs.slice(start) : pairs;
}

function readEntityOwner(pairs: DxfPair[]): string | undefined {
  const subclass = pairsAfterSubclass(pairs, 'AcDbAttribute');
  return readHandle(subclass, 330) ?? readHandle(pairs, 330);
}

function readObjectOwner(pairs: DxfPair[]): string | undefined {
  const subclassIndex = pairs.findIndex((pair) => pair.code === 100);
  const candidates = pairs.slice(0, subclassIndex >= 0 ? subclassIndex : pairs.length).filter((pair) => pair.code === 330);
  return candidates.at(-1)?.value ?? pairs.find((pair) => pair.code === 330)?.value;
}

function readString(pairs: DxfPair[], code: number): string | undefined {
  return stringOrUndefined(pairs.find((pair) => pair.code === code)?.value);
}

function readJoined(pairs: DxfPair[], codes: number[]): string | undefined {
  const values = pairs.filter((pair) => codes.includes(pair.code)).map((pair) => pair.value);
  return values.length > 0 ? values.join('') : undefined;
}

function readHandle(pairs: DxfPair[], code: number): string | undefined {
  const value = readString(pairs, code);
  return value?.trim() || undefined;
}

function readNumber(pairs: DxfPair[], code: number): number | undefined {
  const pair = pairs.find((candidate) => candidate.code === code);
  if (!pair) return undefined;
  const value = Number(pair.value);
  return Number.isFinite(value) ? value : undefined;
}

function readNumbers(pairs: DxfPair[], code: number): number[] {
  return pairs.filter((pair) => pair.code === code).map((pair) => Number(pair.value)).filter(Number.isFinite);
}

function readPoint(pairs: DxfPair[], xCode: number): CadPoint3D | undefined {
  const x = readNumber(pairs, xCode);
  const y = readNumber(pairs, xCode + 10);
  const z = readNumber(pairs, xCode + 20);
  if (x === undefined || y === undefined) return undefined;
  return z === undefined ? { x, y } : { x, y, z };
}

function dxfValue(pair: DxfPair): CadDataValue {
  if (pair.code === 290) return pair.value.trim() !== '0';
  if (isStringCode(pair.code)) return decodeCadText(pair.value) ?? pair.value;
  const number = Number(pair.value);
  return Number.isFinite(number) ? number : pair.value;
}

function isStringCode(code: number): boolean {
  return (code >= 0 && code <= 9)
    || code === 100 || code === 101 || code === 102 || code === 105
    || (code >= 300 && code <= 369)
    || (code >= 390 && code <= 399)
    || (code >= 410 && code <= 419)
    || (code >= 430 && code <= 439)
    || (code >= 470 && code <= 481)
    || (code >= 999 && code <= 1009);
}

function decodeCadText(value: unknown): string | undefined {
  const text = stringOrUndefined(value);
  if (text === undefined) return undefined;
  return text
    .replace(/\\U\+([0-9a-fA-F]{4,6})/g, (match, code: string) => {
      const point = Number.parseInt(code, 16);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/%%[cC]/g, '\u2205')
    .replace(/%%[dD]/g, '\u00b0')
    .replace(/%%[pP]/g, '\u00b1')
    .replace(/\\P/g, '\n');
}

function indexEntity(entity: CadEntity, target: Map<string, CadEntity>): void {
  if (entity.handle) target.set(canonicalHandle(entity.handle), entity);
}

function indexEntityContext(
  entities: CadEntity[],
  context: string,
  handles: Map<string, CadEntity>,
  locators: Map<string, CadEntity>
): void {
  const counters = new Map<string, number>();
  for (const entity of entities) {
    indexEntity(entity, handles);
    const type = locatorType(entity.type);
    if (!isLocatableEntityType(type)) continue;
    const ordinal = counters.get(type) ?? 0;
    counters.set(type, ordinal + 1);
    locators.set(locatorKey({ context, type, ordinal }), entity);
  }
}

function createRecordLocator(record: DxfRecord, context: string, counters: Map<string, number>): DxfEntityLocator | undefined {
  if (record.section !== 'ENTITIES' && record.section !== 'BLOCKS') return undefined;
  const type = locatorType(record.type);
  if (!isLocatableEntityType(type)) return undefined;
  const key = `${context}\u0000${type}`;
  const ordinal = counters.get(key) ?? 0;
  counters.set(key, ordinal + 1);
  return { context, type, ordinal };
}

function locatorType(type: string): string {
  const normalized = type.trim().toUpperCase();
  if (normalized === 'MINSERT') return 'INSERT';
  if (/^POLYLINE(?:2D|3D|_2D|_3D)?$/.test(normalized)) return 'POLYLINE';
  if (normalized === 'ACAD_TABLE' || normalized === 'ACDBTABLE') return 'TABLE';
  return normalized;
}

function isLocatableEntityType(type: string): boolean {
  return !['', 'ATTRIB', 'SEQEND', 'VERTEX', 'BLOCK', 'ENDBLK'].includes(type);
}

function canonicalContext(section: string, blockName?: string): string {
  return `${section.trim().toUpperCase()}\u0000${blockName?.trim().toUpperCase() ?? ''}`;
}

function locatorKey(locator: DxfEntityLocator): string {
  return `${locator.context}\u0000${locator.type}\u0000${locator.ordinal}`;
}

function sameAttribute(left: CadEntity, right: CadEntity): boolean {
  if (left.handle && right.handle) return canonicalHandle(left.handle) === canonicalHandle(right.handle);
  return (left.attributeTag ?? '').trim().toLocaleUpperCase() === (right.attributeTag ?? '').trim().toLocaleUpperCase()
    && (left.text ?? left.value ?? '') === (right.text ?? right.value ?? '')
    && samePoint(left.insertionPoint, right.insertionPoint);
}

function samePoint(left: CadPoint3D | undefined, right: CadPoint3D | undefined): boolean {
  if (!left || !right) return left === right;
  return left.x === right.x && left.y === right.y && (left.z ?? 0) === (right.z ?? 0);
}

function canonicalHandle(handle: string): string {
  return handle.trim().toUpperCase();
}

function boundedCount(value: number | undefined, max: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return 0;
  return Math.min(max, Math.trunc(value));
}

function degreesToRadians(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * Math.PI / 180;
}

function numberValue(value: string): number | string {
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function safeIsoDate(year: number, month: number, day: number, hour: number, minute: number, second: number, millisecond: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function mergeByHandle<T extends { handle?: string }>(current: T[] | undefined, added: T[]): T[] {
  const result = [...(current ?? [])];
  const indexByHandle = new Map<string, number>();
  result.forEach((item, index) => { if (item.handle) indexByHandle.set(canonicalHandle(item.handle), index); });
  for (const item of added) {
    const key = item.handle ? canonicalHandle(item.handle) : undefined;
    const existing = key ? indexByHandle.get(key) : undefined;
    if (existing === undefined) {
      if (key) indexByHandle.set(key, result.length);
      result.push(item);
    } else {
      result[existing] = item;
    }
  }
  return result;
}
