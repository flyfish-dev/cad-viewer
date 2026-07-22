import type {
  CadBlock,
  CadBom,
  CadBomColumn,
  CadBomCsvOptions,
  CadBomJsonOptions,
  CadBomOptions,
  CadBomRow,
  CadBomSourceKind,
  CadBomTable,
  CadBomWarning,
  CadDataLink,
  CadDataScalar,
  CadDataTable,
  CadDataValue,
  CadDocument,
  CadEntity,
  CadTableCell,
  CadXData,
  CadXRecord
} from './types';

const ALL_SOURCES: readonly CadBomSourceKind[] = [
  'block-attributes',
  'native-table',
  'data-table',
  'xdata',
  'xrecord',
  'text-table'
];

// XDATA and XRECORD are arbitrary application containers. Real DWGs commonly
// contain large internal history/index/tag caches which are useful for
// diagnostics but are not BOM tables. Keep full extraction available through
// `sources` without flooding the default result.
const DEFAULT_SOURCES: readonly CadBomSourceKind[] = ALL_SOURCES.filter((source) => source !== 'xdata' && source !== 'xrecord');

// Coordinates this large cannot describe a useful BOM grid. Rejecting them
// also keeps malformed sparse TABLE data from turning into costly structures.
const MAX_TABLE_COORDINATE = 1_000_000;

interface ResolvedBomOptions {
  sources: Set<CadBomSourceKind>;
  textTables: 'auto' | boolean;
  recursiveBlocks: boolean;
  aggregateBlocks: boolean;
  includeInvisible: boolean;
  includePaperSpace: boolean;
  includeAnonymousBlocks: boolean;
  maxDepth: number;
  maxEntities: number;
  maxRows: number;
  maxCells: number;
  minTextTableRows: number;
  minTextTableColumns: number;
  textRowTolerance?: number;
  textColumnTolerance?: number;
}

interface ExtractionContext {
  document: CadDocument;
  options: ResolvedBomOptions;
  tables: CadBomTable[];
  warnings: CadBomWarning[];
  visitedEntities: number;
  seenEntities: WeakSet<CadEntity>;
  emittedRows: number;
  stopped: boolean;
}

interface BlockOccurrence {
  blockName: string;
  effectiveName: string;
  attributes: Record<string, string>;
  attributeLabels: Record<string, string>;
  quantity: number;
  layers: Set<string>;
  handles: Set<string>;
}

/**
 * Extracts structured BOM data from the parser-owned source document.
 *
 * The result keeps independent schedules as separate tables instead of forcing
 * unrelated ACAD_TABLE, block-attribute and XDATA schemas into one lossy grid.
 */
export function extractCadBom(document: CadDocument, options: CadBomOptions = {}): CadBom {
  const resolved = resolveOptions(options);
  const context: ExtractionContext = {
    document,
    options: resolved,
    tables: [],
    warnings: [],
    visitedEntities: 0,
    seenEntities: new WeakSet<CadEntity>(),
    emittedRows: 0,
    stopped: false
  };

  if (resolved.sources.has('block-attributes')) addTable(context, extractBlockTable(context));
  if (resolved.sources.has('native-table')) {
    for (const table of extractNativeTables(context)) addTable(context, table);
  }
  if (resolved.sources.has('data-table')) {
    for (const table of extractDataTables(context)) addTable(context, table);
  }
  if (resolved.sources.has('xdata')) {
    for (const table of extractXDataTables(context)) addTable(context, table);
  }
  if (resolved.sources.has('xrecord')) {
    for (const table of extractXRecordTables(context)) addTable(context, table);
  }
  if (resolved.sources.has('text-table') && resolved.textTables !== false) {
    for (const table of extractTextTables(context)) addTable(context, table);
  }

  if (!['dwg', 'dxf'].includes(document.format) && context.tables.length === 0) {
    context.warnings.push({
      code: 'unsupported-format',
      message: `${document.format.toUpperCase()} does not expose a normalized component/property model for BOM extraction.`
    });
  }

  const sourceCounts: Partial<Record<CadBomSourceKind, number>> = {};
  for (const table of context.tables) sourceCounts[table.source] = (sourceCounts[table.source] ?? 0) + 1;
  const blockTables = context.tables.filter((table) => table.source === 'block-attributes');
  const warnings = dedupeWarnings([
    ...context.warnings,
    ...context.tables.flatMap((table) => table.warnings)
  ]);
  return {
    schemaVersion: 1,
    sourceName: document.sourceName,
    format: document.format,
    tables: context.tables,
    summary: {
      tableCount: context.tables.length,
      rowCount: context.tables.reduce((count, table) => count + table.rows.length, 0),
      sourceCounts,
      blockItemCount: blockTables.reduce((count, table) => count + table.rows.length, 0),
      blockQuantity: blockTables.reduce(
        (count, table) => table.rows.reduce((sum, row) => safeQuantitySum(sum, row.quantity ?? 1), count),
        0
      )
    },
    warnings
  };
}

export function serializeCadBomJson(bom: CadBom, options: CadBomJsonOptions = {}): string {
  const replacer = options.includeSensitiveData === true
    ? undefined
    : (key: string, value: unknown) => key === 'connectionString' ? undefined : value;
  return JSON.stringify(bom, replacer, options.pretty === false ? undefined : 2);
}

/** Serializes one BOM table as spreadsheet-safe RFC 4180 CSV. */
export function serializeCadBomCsv(bom: CadBom, options: CadBomCsvOptions = {}): string {
  const table = options.tableId
    ? bom.tables.find((candidate) => candidate.id === options.tableId)
    : [...bom.tables].sort((left, right) => right.rows.length - left.rows.length)[0];
  if (!table) return options.includeUtf8Bom === false ? '' : '\uFEFF';
  const delimiter = options.delimiter ?? ',';
  const lineEnding = options.lineEnding ?? '\r\n';
  const escapeFormulas = options.escapeFormulas !== false;
  const rows = [
    table.columns.map((column) => column.label),
    ...table.rows.map((row) => table.columns.map((column) => row.cells[column.key] ?? ''))
  ];
  const csv = rows.map((row) => row.map((value) => quoteCsvCell(value, delimiter, escapeFormulas)).join(delimiter)).join(lineEnding);
  return options.includeUtf8Bom === false ? csv : `\uFEFF${csv}`;
}

function resolveOptions(options: CadBomOptions): ResolvedBomOptions {
  return {
    sources: new Set(options.sources?.filter((source) => ALL_SOURCES.includes(source)) ?? DEFAULT_SOURCES),
    textTables: options.textTables ?? 'auto',
    recursiveBlocks: options.recursiveBlocks !== false,
    aggregateBlocks: options.aggregateBlocks !== false,
    includeInvisible: options.includeInvisible !== false,
    includePaperSpace: options.includePaperSpace === true,
    includeAnonymousBlocks: options.includeAnonymousBlocks === true,
    maxDepth: boundedInteger(options.maxDepth, 16, 1, 128),
    maxEntities: boundedInteger(options.maxEntities, 250000, 1, 2_000_000),
    maxRows: boundedInteger(options.maxRows, 100000, 1, 1_000_000),
    maxCells: boundedInteger(options.maxCells, 1_000_000, 1, 5_000_000),
    minTextTableRows: boundedInteger(options.minTextTableRows, 3, 2, 100),
    minTextTableColumns: boundedInteger(options.minTextTableColumns, 2, 2, 100),
    textRowTolerance: positiveFinite(options.textRowTolerance),
    textColumnTolerance: positiveFinite(options.textColumnTolerance)
  };
}

function addTable(context: ExtractionContext, table: CadBomTable | undefined): void {
  if (!table || table.rows.length === 0) return;
  table.warnings = dedupeWarnings(table.warnings);
  const remaining = context.options.maxRows - context.emittedRows;
  if (remaining <= 0) {
    stopForRowLimit(context, table.source);
    return;
  }
  if (table.rows.length > remaining) {
    table.rows = table.rows.slice(0, remaining);
    const warning: CadBomWarning = {
      code: 'max-rows',
      source: table.source,
      message: `BOM extraction stopped at the configured ${context.options.maxRows.toLocaleString()} row limit.`
    };
    table.warnings.push(warning);
    context.warnings.push(warning);
    context.stopped = true;
  }
  table.warnings = dedupeWarnings(table.warnings);
  context.emittedRows += table.rows.length;
  context.tables.push(table);
}

function remainingRows(context: ExtractionContext, pendingRows = 0): number {
  return Math.max(0, context.options.maxRows - context.emittedRows - pendingRows);
}

function stopForRowLimit(context: ExtractionContext, source: CadBomSourceKind): void {
  if (context.stopped) return;
  context.stopped = true;
  context.warnings.push({
    code: 'max-rows',
    source,
    message: `BOM extraction stopped at the configured ${context.options.maxRows.toLocaleString()} row limit.`
  });
}

function extractBlockTable(context: ExtractionContext): CadBomTable | undefined {
  const occurrences: BlockOccurrence[] = [];
  const aggregated = new Map<string, BlockOccurrence>();
  const roots = documentEntities(context.document, context.options.includePaperSpace);

  const visit = (entity: CadEntity, multiplier: number, stack: string[], depth: number): void => {
    if (context.stopped || !isEntityIncluded(entity, context.options)) return;
    if (!consumeEntity(context, 'block-attributes', entity)) return;
    if (entity.kind !== 'insert' && !/^(INSERT|MINSERT)$/i.test(entity.type)) return;
    const blockName = cleanText(entity.blockName ?? entity.name) || '(unnamed block)';
    const effectiveName = cleanText(entity.effectiveBlockName) || blockName;
    if (isInfrastructureBlock(blockName)) return;
    const isAnonymous = /^\*/.test(blockName);
    // AutoCAD dynamic blocks commonly use anonymous *U### records. Some
    // converters do not expose their effective name, so excluding every
    // anonymous block by default silently drops real parts from the BOM.
    if (isAnonymous
      && !isDynamicAnonymousBlock(blockName)
      && !context.options.includeAnonymousBlocks
      && effectiveName === blockName) return;

    const block = lookupBlock(context.document.blocks, blockName);
    const attributes = collectBlockAttributes(entity, block, context.warnings);
    const count = safeMultiplicity(entity.insertRowCount, entity.insertColumnCount);
    const quantity = safeQuantity(multiplier, count);
    const labels = Object.fromEntries(Object.keys(attributes).map((key) => [canonicalAttributeKey(key), key]));
    const occurrence: BlockOccurrence = {
      blockName,
      effectiveName,
      attributes: canonicalAttributeRecord(attributes),
      attributeLabels: labels,
      quantity,
      layers: new Set(entity.layer ? [entity.layer] : []),
      handles: new Set(entity.handle ? [entity.handle] : [])
    };

    if (context.options.aggregateBlocks) {
      const key = stableKey([effectiveName.toLocaleUpperCase(), occurrence.attributes]);
      const current = aggregated.get(key);
      if (current) {
        current.quantity = safeQuantity(current.quantity, quantity, true);
        for (const layer of occurrence.layers) current.layers.add(layer);
        for (const handle of occurrence.handles) current.handles.add(handle);
      } else {
        aggregated.set(key, occurrence);
      }
    } else {
      occurrences.push(occurrence);
    }

    if (!context.options.recursiveBlocks || !block) {
      if (context.options.recursiveBlocks && !block && blockName !== '(unnamed block)') {
        context.warnings.push({ code: 'missing-block', source: 'block-attributes', blockName, handle: entity.handle, message: `Block definition ${blockName} is missing; the reference is still included.` });
      }
      return;
    }
    if (depth >= context.options.maxDepth) {
      context.warnings.push({ code: 'max-depth', source: 'block-attributes', blockName, message: `Stopped recursive block traversal at depth ${context.options.maxDepth}.` });
      return;
    }
    const cycleKey = block.name.toLocaleUpperCase();
    if (stack.includes(cycleKey)) {
      context.warnings.push({ code: 'cyclic-block', source: 'block-attributes', blockName, message: `Skipped cyclic block reference ${[...stack, cycleKey].join(' → ')}.` });
      return;
    }
    for (const child of block.entities) visit(child, quantity, [...stack, cycleKey], depth + 1);
  };

  for (const entity of roots) visit(entity, 1, [], 0);
  const allItems = context.options.aggregateBlocks ? [...aggregated.values()] : occurrences;
  const itemLimit = remainingRows(context);
  const items = allItems.slice(0, itemLimit);
  if (items.length === 0) return undefined;

  const attributeLabels = new Map<string, string>();
  for (const item of items) {
    for (const [canonical, label] of Object.entries(item.attributeLabels)) if (!attributeLabels.has(canonical)) attributeLabels.set(canonical, label);
  }
  const dynamic = [...attributeLabels.entries()].sort(([left], [right]) => left.localeCompare(right));
  const usedKeys = new Set(['item', 'block', 'quantity', 'layers']);
  const attributeColumns = dynamic.map(([sourceKey, label]) => ({
    key: uniqueColumnKey(slugKey(label), usedKeys),
    label,
    dataType: 'string' as const,
    sourceKey
  }));
  const columns: CadBomColumn[] = [
    { key: 'item', label: 'Item', dataType: 'string' },
    { key: 'block', label: 'Source block', dataType: 'string' },
    { key: 'quantity', label: 'Quantity', dataType: 'number' },
    { key: 'layers', label: 'Layers', dataType: 'string' },
    ...attributeColumns
  ];
  const rows: CadBomRow[] = items
    .sort((left, right) => left.effectiveName.localeCompare(right.effectiveName, undefined, { numeric: true }))
    .map((item, index) => {
      const cells: Record<string, CadDataScalar> = {
        item: item.effectiveName,
        block: item.blockName,
        quantity: item.quantity,
        layers: [...item.layers].sort().join(', ')
      };
      for (const column of attributeColumns) cells[column.key] = item.attributes[column.sourceKey!] ?? '';
      return {
        id: `block-${index + 1}`,
        cells,
        quantity: item.quantity,
        sourceHandles: [...item.handles],
        blockName: item.blockName,
        effectiveBlockName: item.effectiveName,
        layer: [...item.layers].sort().join(', ')
      };
    });
  const warnings: CadBomWarning[] = [];
  if (items.length < allItems.length) {
    warnings.push({
      code: 'max-rows',
      source: 'block-attributes',
      message: `Block BOM rows were capped at the configured ${context.options.maxRows.toLocaleString()} row limit.`
    });
  }
  return { id: 'block-attributes', name: 'Block attributes', source: 'block-attributes', confidence: 1, columns, rows, warnings };
}

function extractNativeTables(context: ExtractionContext): CadBomTable[] {
  const result: CadBomTable[] = [];
  const entities = allDocumentEntities(context.document, context.options.includePaperSpace);
  let index = 0;
  let pendingRows = 0;
  for (const entity of entities) {
    if (context.stopped) break;
    const rowBudget = remainingRows(context, pendingRows);
    if (rowBudget <= 0) break;
    if (!isEntityIncluded(entity, context.options)) continue;
    if (entity.kind !== 'table' && !/^(TABLE|ACAD_TABLE|ACDBTABLE)$/i.test(entity.type)) continue;
    index += 1;
    if (!consumeEntity(context, 'native-table', entity)) break;
    const table = entity.table;
    if (!table || table.cells.length === 0) {
      const warning: CadBomWarning = {
        code: 'empty-native-table',
        source: 'native-table',
        handle: entity.handle,
        message: `Native table ${entity.handle ?? index} has no cached cells. Modern TABLECONTENT or its external DataLink may not be exposed by the DWG parser.`
      };
      context.warnings.push(warning);
      continue;
    }
    const warnings: CadBomWarning[] = [];
    if (table.cells.length > context.options.maxCells) {
      const warning: CadBomWarning = {
        code: 'max-cells',
        source: 'native-table',
        handle: entity.handle,
        message: `Native table cells were capped at ${context.options.maxCells.toLocaleString()} values.`
      };
      warnings.push(warning);
    }
    const bomTable = nativeCellsToBomTable(
      entity,
      index,
      context.document.dataLinks ?? [],
      warnings,
      rowBudget,
      context.options.maxCells
    );
    if (bomTable.rows.length > 0) {
      pendingRows += bomTable.rows.length;
      result.push(bomTable);
    }
  }
  return result;
}

function nativeCellsToBomTable(
  entity: CadEntity,
  index: number,
  links: CadDataLink[],
  warnings: CadBomWarning[],
  maxRows: number,
  maxCells: number
): CadBomTable {
  const source = entity.table!;
  const populatedRows = new Map<number, Map<number, CadTableCell>>();
  const actualColumns = new Set<number>();
  const maxStoredRows = Math.max(1, Math.min(maxCells, maxRows + 2));
  let invalidCoordinates = 0;
  let skippedRows = 0;
  for (let cellIndex = 0; cellIndex < source.cells.length && cellIndex < maxCells; cellIndex += 1) {
    const cell = source.cells[cellIndex];
    if (!isValidTableCoordinate(cell.row) || !isValidTableCoordinate(cell.column)) {
      invalidCoordinates += 1;
      continue;
    }
    if (!populatedRows.has(cell.row) && populatedRows.size >= maxStoredRows) {
      skippedRows += 1;
      continue;
    }
    const row = populatedRows.get(cell.row) ?? new Map<number, CadTableCell>();
    if (!row.has(cell.column) || (!row.get(cell.column)?.text && cell.text)) row.set(cell.column, cell);
    populatedRows.set(cell.row, row);
    if (cellDisplayValue(cell) !== '') actualColumns.add(cell.column);
  }
  if (invalidCoordinates > 0) {
    warnings.push({
      code: 'invalid-table-cell',
      source: 'native-table',
      handle: entity.handle,
      message: `Ignored ${invalidCoordinates.toLocaleString()} native table cell${invalidCoordinates === 1 ? '' : 's'} with invalid or extreme coordinates.`
    });
  }
  if (skippedRows > 0) {
    warnings.push({
      code: 'max-rows',
      source: 'native-table',
      handle: entity.handle,
      message: `Native table rows were capped at the configured ${maxRows.toLocaleString()} row limit.`
    });
  }
  const rowIndexes = [...populatedRows.keys()].sort((left, right) => left - right);
  let name = cleanText(source.name) || `Native table ${index}`;
  let firstDataRow = rowIndexes[0];
  const firstRow = firstDataRow === undefined ? undefined : populatedRows.get(firstDataRow);
  if (firstRow) {
    const nonEmpty = [...firstRow.values()].filter((cell) => cellDisplayValue(cell) !== '');
    if (source.titleSuppressed !== true && nonEmpty.length === 1 && rowIndexes.length > 1) {
      name = cellDisplayValue(nonEmpty[0]) || name;
      firstDataRow = rowIndexes[1];
    }
  }
  const dataStartIndex = Math.max(0, rowIndexes.indexOf(firstDataRow));
  const possibleHeaderIndex = rowIndexes[dataStartIndex];
  const possibleHeader = possibleHeaderIndex === undefined ? undefined : populatedRows.get(possibleHeaderIndex);
  const bodyIndexes = rowIndexes.slice(dataStartIndex + 1);
  const hasHeader = source.headerSuppressed !== true
    && !!possibleHeader
    && (source.headerSuppressed === false || likelyHeaderRow(possibleHeader, bodyIndexes.map((row) => populatedRows.get(row)!)));
  const allDataRows = hasHeader ? bodyIndexes : rowIndexes.slice(dataStartIndex);
  const dataRows = allDataRows.slice(0, Math.min(maxRows, maxCells));
  const sortedColumns = [...actualColumns].sort((left, right) => left - right);
  const columnLimit = Math.max(1, Math.floor(maxCells / Math.max(1, dataRows.length)));
  const activeColumns = sortedColumns.slice(0, columnLimit);
  if (allDataRows.length > dataRows.length) {
    warnings.push({
      code: 'max-rows',
      source: 'native-table',
      handle: entity.handle,
      message: `Native table rows were capped at the configured ${maxRows.toLocaleString()} row limit.`
    });
  }
  if (activeColumns.length < sortedColumns.length) {
    warnings.push({
      code: 'max-cells',
      source: 'native-table',
      handle: entity.handle,
      message: `Native table output was capped at ${maxCells.toLocaleString()} cells.`
    });
  }
  const usedKeys = new Set<string>();
  const columns: CadBomColumn[] = activeColumns.map((column, columnIndex) => {
    const header = hasHeader ? cellDisplayValue(possibleHeader?.get(column)) : '';
    const label = header || `Column ${columnIndex + 1}`;
    return {
      key: uniqueColumnKey(slugKey(label), usedKeys),
      label,
      dataType: inferColumnType(dataRows.map((row) => cellScalar(populatedRows.get(row)?.get(column)))),
      sourceKey: String(column)
    };
  });
  const rows: CadBomRow[] = [];
  for (const rowIndex of dataRows) {
    if (rows.length >= maxRows) break;
    const sourceRow = populatedRows.get(rowIndex)!;
    const values: Record<string, CadDataScalar> = {};
    let hasValue = false;
    for (const column of columns) {
      const cell = sourceRow.get(Number(column.sourceKey));
      const value = cellScalar(cell);
      values[column.key] = value;
      if (value !== '') hasValue = true;
    }
    if (hasValue) rows.push({ id: `native-${entity.handle ?? index}-${rowIndex}`, cells: values, sourceHandles: entity.handle ? [entity.handle] : undefined });
  }
  const link = source.dataLinkHandle
    ? links.find((candidate) => handleEquals(candidate.handle, source.dataLinkHandle))
    : undefined;
  if (source.dataLinkHandle && !link) {
    warnings.push({
      code: 'external-data-unavailable',
      source: 'native-table',
      handle: entity.handle,
      message: `Table references DataLink ${source.dataLinkHandle}, but no link metadata or external workbook was embedded. Cached cells are returned without network access.`
    });
  }
  return {
    id: `native-table-${entity.handle ?? index}`,
    name,
    source: 'native-table',
    confidence: 1,
    columns,
    rows,
    handle: entity.handle,
    dataLink: link,
    warnings
  };
}

function extractDataTables(context: ExtractionContext): CadBomTable[] {
  const result: CadBomTable[] = [];
  let pendingRows = 0;
  for (let index = 0; index < (context.document.dataTables?.length ?? 0); index += 1) {
    const rowBudget = remainingRows(context, pendingRows);
    if (context.stopped || rowBudget <= 0) break;
    const table = dataTableToBom(
      context.document.dataTables![index],
      index,
      rowBudget,
      context.options.maxCells
    );
    if (table.rows.length > 0) {
      pendingRows += table.rows.length;
      result.push(table);
    }
  }
  return result;
}

function dataTableToBom(table: CadDataTable, index: number, maxRows: number, maxCells: number): CadBomTable {
  const sourceColumns = table.columns.slice(0, maxCells);
  let availableRows = 0;
  for (const column of sourceColumns) availableRows = Math.max(availableRows, column.values.length);
  // DATATABLE stores values as independent column arrays. Bound both the
  // number of columns and the number of inspected values in each column so
  // type inference and row construction never map an unbounded source array.
  const actualRows = sourceColumns.length > 0 ? Math.min(maxRows, maxCells, availableRows) : 0;
  const usedKeys = new Set<string>();
  const columns: CadBomColumn[] = sourceColumns.map((column, columnIndex) => ({
    key: uniqueColumnKey(slugKey(column.name || `Column ${columnIndex + 1}`), usedKeys),
    label: column.name || `Column ${columnIndex + 1}`,
    dataType: inferDataValueColumnType(column.values, actualRows),
    sourceKey: String(columnIndex)
  }));
  const rows: CadBomRow[] = [];
  for (let rowIndex = 0; rowIndex < actualRows; rowIndex += 1) {
    const cells: Record<string, CadDataScalar> = {};
    let hasValue = false;
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const value = dataValueToScalar(sourceColumns[columnIndex]?.values[rowIndex]);
      cells[columns[columnIndex].key] = value;
      if (value !== '') hasValue = true;
    }
    if (hasValue) rows.push({ id: `data-${table.handle ?? index}-${rowIndex}`, cells, sourceHandles: table.handle ? [table.handle] : undefined });
  }
  const warnings: CadBomWarning[] = [];
  if (sourceColumns.length < table.columns.length || maxCells < Math.min(maxRows, availableRows)) {
    warnings.push({
      code: 'max-cells',
      source: 'data-table',
      handle: table.handle,
      message: `DataTable columns and values per column were capped at ${maxCells.toLocaleString()} entries.`
    });
  }
  if (actualRows < Math.min(maxCells, availableRows)) {
    warnings.push({
      code: 'max-rows',
      source: 'data-table',
      handle: table.handle,
      message: `DataTable rows were capped at the configured BOM row limit.`
    });
  }
  return {
    id: `data-table-${table.handle ?? index + 1}`,
    name: cleanText(table.name) || `Data table ${index + 1}`,
    source: 'data-table',
    confidence: 1,
    columns,
    rows,
    handle: table.handle,
    warnings
  };
}

function extractXDataTables(context: ExtractionContext): CadBomTable[] {
  const byApplication = new Map<string, Array<{ entity: CadEntity; group: CadXData; sequence: number }>>();
  for (const entity of allDocumentEntities(context.document, context.options.includePaperSpace)) {
    if (context.stopped) break;
    if (!consumeEntity(context, 'xdata', entity)) break;
    if (!isEntityIncluded(entity, context.options)) continue;
    for (let sequence = 0; sequence < (entity.xdata?.length ?? 0); sequence += 1) {
      const group = entity.xdata![sequence];
      if (group.entries.length === 0) continue;
      const application = cleanText(group.appName) || 'Unscoped XDATA';
      const entries = byApplication.get(application) ?? [];
      entries.push({ entity, group, sequence });
      byApplication.set(application, entries);
    }
  }

  const result: CadBomTable[] = [];
  const usedTableIds = new Set<string>();
  let pendingRows = 0;
  for (const [application, groups] of byApplication) {
    const rowBudget = remainingRows(context, pendingRows);
    if (rowBudget <= 0) break;
    const selectedGroups = groups.slice(0, rowBudget);
    const flattened = selectedGroups.map(({ group }) => flattenXData(group));
    const dynamicKeys = [...new Set(flattened.flatMap((record) => Object.keys(record)))].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const usedKeys = new Set(['entity', 'type', 'block', 'layer']);
    const dynamicColumns = dynamicKeys.map((sourceKey) => ({
      key: uniqueColumnKey(slugKey(sourceKey), usedKeys),
      label: sourceKey,
      dataType: inferColumnType(flattened.map((record) => record[sourceKey] ?? '')),
      sourceKey
    }));
    const columns: CadBomColumn[] = [
      { key: 'entity', label: 'Entity', dataType: 'string' },
      { key: 'type', label: 'Type', dataType: 'string' },
      { key: 'block', label: 'Block', dataType: 'string' },
      { key: 'layer', label: 'Layer', dataType: 'string' },
      ...dynamicColumns
    ];
    const tableId = uniqueId(`xdata-${slugKey(application)}`, usedTableIds);
    const rows: CadBomRow[] = selectedGroups.map(({ entity, sequence }, rowIndex) => {
      const cells: Record<string, CadDataScalar> = {
        entity: entity.handle ?? String(rowIndex + 1),
        type: entity.type,
        block: entity.effectiveBlockName ?? entity.blockName ?? '',
        layer: entity.layer ?? ''
      };
      for (const column of dynamicColumns) cells[column.key] = flattened[rowIndex][column.sourceKey!] ?? '';
      return { id: `${tableId}-${rowIndex}-${sequence}`, cells, sourceHandles: entity.handle ? [entity.handle] : undefined };
    });
    const warnings: CadBomWarning[] = [];
    if (selectedGroups.length < groups.length) {
      warnings.push({ code: 'max-rows', source: 'xdata', message: `XDATA rows were capped at the configured BOM row limit.` });
    }
    pendingRows += rows.length;
    result.push({ id: tableId, name: application, source: 'xdata', confidence: 1, columns, rows, warnings });
  }
  return result;
}

function extractXRecordTables(context: ExtractionContext): CadBomTable[] {
  const result: CadBomTable[] = [];
  let pendingRows = 0;
  for (let index = 0; index < (context.document.xrecords?.length ?? 0); index += 1) {
    const rowBudget = remainingRows(context, pendingRows);
    if (context.stopped || rowBudget <= 0) break;
    const record = context.document.xrecords![index];
    if (record.data.length === 0) continue;
    const limit = Math.min(record.data.length, context.options.maxCells, rowBudget);
    const warnings: CadBomWarning[] = [];
    if (context.options.maxCells < Math.min(record.data.length, rowBudget)) {
      warnings.push({ code: 'max-cells', source: 'xrecord', handle: record.handle, message: `XRecord groups were capped at ${context.options.maxCells.toLocaleString()} values.` });
    }
    if (rowBudget < Math.min(record.data.length, context.options.maxCells)) {
      warnings.push({ code: 'max-rows', source: 'xrecord', handle: record.handle, message: `XRecord rows were capped at the configured BOM row limit.` });
    }
    const rows: CadBomRow[] = [];
    for (let groupIndex = 0; groupIndex < limit; groupIndex += 1) {
      const group = record.data[groupIndex];
      rows.push({
        id: `xrecord-${record.handle ?? index}-${groupIndex}`,
        cells: {
          index: groupIndex + 1,
          code: group.code ?? '',
          value: dataValueToScalar(group.value)
        },
        sourceHandles: record.handle ? [record.handle] : undefined
      });
    }
    const path = record.dictionaryPath?.join(' / ');
    result.push({
      id: `xrecord-${record.handle ?? index + 1}`,
      name: path || record.entryName || `XRecord ${record.handle ?? index + 1}`,
      source: 'xrecord',
      confidence: 1,
      columns: [
        { key: 'index', label: '#', dataType: 'number' },
        { key: 'code', label: 'Group code', dataType: 'mixed' },
        { key: 'value', label: 'Value', dataType: 'mixed' }
      ],
      rows,
      handle: record.handle,
      warnings
    });
    pendingRows += rows.length;
  }
  return result;
}

interface TextCandidate {
  entity: CadEntity;
  text: string;
  x: number;
  y: number;
  height: number;
}

interface TextRow {
  y: number;
  cells: TextCandidate[];
}

function nearestTextColumn(
  centers: Array<{ x: number }>,
  x: number,
  maxDistance = Number.POSITIVE_INFINITY
): { column: number; distance: number } | undefined {
  let low = 0;
  let high = centers.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (centers[middle].x < x) low = middle + 1;
    else high = middle;
  }
  let best: { column: number; distance: number } | undefined;
  for (const column of [low - 1, low]) {
    if (column < 0 || column >= centers.length) continue;
    const distance = Math.abs(centers[column].x - x);
    if (distance <= maxDistance && (!best || distance < best.distance)) best = { column, distance };
  }
  return best;
}

function extractTextTables(context: ExtractionContext): CadBomTable[] {
  const byLayer = new Map<string, TextCandidate[]>();
  let collectedCells = 0;
  for (const entity of documentEntities(context.document, context.options.includePaperSpace)) {
    if (context.stopped) break;
    if (!consumeEntity(context, 'text-table', entity)) break;
    if (!isEntityIncluded(entity, context.options) || !/^(TEXT|MTEXT)$/i.test(entity.type)) continue;
    const point = entity.insertionPoint ?? entity.startPoint;
    const text = normalizeCadText(entity.text);
    if (!point || !text || !isNearlyHorizontal(entity.rotation)) continue;
    if (collectedCells >= context.options.maxCells) {
      context.warnings.push({
        code: 'max-cells',
        source: 'text-table',
        message: `Text-table candidates were capped at ${context.options.maxCells.toLocaleString()} entities.`
      });
      break;
    }
    const layer = entity.layer ?? '0';
    const candidates = byLayer.get(layer) ?? [];
    candidates.push({ entity, text, x: point.x, y: point.y, height: Math.max(1e-9, Math.abs(entity.textHeight ?? entity.height ?? 1)) });
    byLayer.set(layer, candidates);
    collectedCells += 1;
  }

  const result: CadBomTable[] = [];
  let tableIndex = 0;
  let pendingRows = 0;
  for (const [layer, candidates] of byLayer) {
    const rowBudget = remainingRows(context, pendingRows);
    if (rowBudget <= 0) break;
    if (candidates.length < context.options.minTextTableRows * context.options.minTextTableColumns) continue;
    const medianHeight = median(candidates.map((candidate) => candidate.height)) || 1;
    const rowTolerance = context.options.textRowTolerance ?? medianHeight * 0.7;
    const columnTolerance = context.options.textColumnTolerance ?? medianHeight * 2.2;
    const rows = clusterTextRows(candidates, rowTolerance);
    for (const group of splitTextRowGroups(rows, rowTolerance)) {
      const remaining = remainingRows(context, pendingRows);
      if (remaining <= 0) break;
      const extracted = textRowsToBom(group, layer, columnTolerance, context.options, tableIndex + 1, remaining);
      if (!extracted) continue;
      tableIndex += 1;
      pendingRows += extracted.rows.length;
      result.push(extracted);
    }
  }
  return result;
}

function clusterTextRows(candidates: TextCandidate[], tolerance: number): TextRow[] {
  const rows: TextRow[] = [];
  for (const candidate of [...candidates].sort((left, right) => right.y - left.y || left.x - right.x)) {
    let row = rows[rows.length - 1];
    if (!row || Math.abs(row.y - candidate.y) > tolerance) {
      row = { y: candidate.y, cells: [] };
      rows.push(row);
    }
    const previousCount = row.cells.length;
    row.cells.push(candidate);
    row.y = (row.y * previousCount + candidate.y) / (previousCount + 1);
  }
  return rows.map((row) => ({ ...row, cells: row.cells.sort((left, right) => left.x - right.x) }));
}

function splitTextRowGroups(rows: TextRow[], rowTolerance: number): TextRow[][] {
  if (rows.length < 2) return rows.length ? [rows] : [];
  const gaps = rows.slice(1).map((row, index) => Math.abs(rows[index].y - row.y)).filter((gap) => gap > rowTolerance);
  const normalGap = median(gaps) || rowTolerance * 2;
  const splitGap = Math.max(rowTolerance * 5, normalGap * 2.6);
  const groups: TextRow[][] = [[]];
  for (let index = 0; index < rows.length; index += 1) {
    if (index > 0 && Math.abs(rows[index - 1].y - rows[index].y) > splitGap) groups.push([]);
    groups[groups.length - 1].push(rows[index]);
  }
  return groups;
}

function textRowsToBom(
  sourceRows: TextRow[],
  layer: string,
  columnTolerance: number,
  options: ResolvedBomOptions,
  index: number,
  maxRows: number
): CadBomTable | undefined {
  if (sourceRows.length < options.minTextTableRows || maxRows <= 0) return undefined;
  const boundedSourceRows = sourceRows.slice(0, Math.max(options.minTextTableRows, maxRows + 1));
  const centers: Array<{ x: number; count: number }> = [];
  const sortedCells = boundedSourceRows.flatMap((row) => row.cells).sort((left, right) => left.x - right.x);
  for (const cell of sortedCells) {
    const center = centers[centers.length - 1];
    if (center && Math.abs(center.x - cell.x) <= columnTolerance) {
      center.x = (center.x * center.count + cell.x) / (center.count + 1);
      center.count += 1;
    } else {
      centers.push({ x: cell.x, count: 1 });
    }
  }
  const usefulCenters = centers.filter((center) => center.count >= Math.max(2, Math.ceil(boundedSourceRows.length * 0.45)));
  if (usefulCenters.length < options.minTextTableColumns) return undefined;

  const matrix = boundedSourceRows.map((row) => {
    const values = new Map<number, TextCandidate[]>();
    for (const cell of row.cells) {
      const nearest = nearestTextColumn(usefulCenters, cell.x, columnTolerance * 1.5);
      if (!nearest) continue;
      const list = values.get(nearest.column) ?? [];
      list.push(cell);
      values.set(nearest.column, list);
    }
    return values;
  });
  const occupied = matrix.reduce((sum, row) => sum + row.size, 0);
  const occupancy = occupied / Math.max(1, boundedSourceRows.length * usefulCenters.length);
  const alignmentDistances = boundedSourceRows.flatMap((row) => row.cells.map((cell) => nearestTextColumn(usefulCenters, cell.x)?.distance ?? columnTolerance));
  const alignment = 1 - Math.min(1, (median(alignmentDistances) || 0) / Math.max(columnTolerance, 1e-9));
  const firstRowValues = usefulCenters.map((_, column) => joinTextCells(matrix[0].get(column)));
  const remainingValues = matrix.slice(1).flatMap((row) => usefulCenters.map((_, column) => joinTextCells(row.get(column))));
  const headerScore = headerLikelihood(firstRowValues, remainingValues);
  const countMedian = median(matrix.map((row) => row.size)) || usefulCenters.length;
  const consistency = 1 - Math.min(1, median(matrix.map((row) => Math.abs(row.size - countMedian))) / Math.max(1, usefulCenters.length));
  const confidence = roundConfidence(occupancy * 0.42 + alignment * 0.28 + consistency * 0.15 + headerScore * 0.15);
  const threshold = options.textTables === true ? 0.48 : 0.82;
  if (confidence < threshold) return undefined;

  const hasHeader = headerScore >= 0.56 && boundedSourceRows.length > options.minTextTableRows;
  const usedKeys = new Set<string>();
  const columns: CadBomColumn[] = usefulCenters.map((_, column) => {
    const label = hasHeader ? firstRowValues[column] || `Column ${column + 1}` : `Column ${column + 1}`;
    const body = matrix.slice(hasHeader ? 1 : 0).map((row) => textToScalar(joinTextCells(row.get(column))));
    return { key: uniqueColumnKey(slugKey(label), usedKeys), label, dataType: inferColumnType(body), sourceKey: String(column) };
  });
  const bodyRows = matrix.slice(hasHeader ? 1 : 0);
  const rows: CadBomRow[] = [];
  for (let rowIndex = 0; rowIndex < bodyRows.length; rowIndex += 1) {
    if (rows.length >= maxRows) break;
    const sourceRow = bodyRows[rowIndex];
    const cells: Record<string, CadDataScalar> = {};
    const handles = new Set<string>();
    let hasValue = false;
    for (const column of columns) {
      const sourceCells = sourceRow.get(Number(column.sourceKey));
      const value = textToScalar(joinTextCells(sourceCells));
      cells[column.key] = value;
      if (value !== '') hasValue = true;
      for (const sourceCell of sourceCells ?? []) if (sourceCell.entity.handle) handles.add(sourceCell.entity.handle);
    }
    if (hasValue) rows.push({ id: `text-${index}-${rowIndex}`, cells, sourceHandles: [...handles] });
  }
  const warnings: CadBomWarning[] = [];
  if (confidence < 0.82) {
    warnings.push({ code: 'low-confidence-text-table', source: 'text-table', message: `Text table reconstruction confidence is ${Math.round(confidence * 100)}%; verify column alignment before using it as a manufacturing BOM.` });
  }
  if (rows.length < bodyRows.length || boundedSourceRows.length < sourceRows.length) {
    warnings.push({ code: 'max-rows', source: 'text-table', message: `Text table rows were capped at the configured BOM row limit.` });
  }
  return {
    id: `text-table-${index}`,
    name: layer === '0' ? `Text table ${index}` : `${layer} text table`,
    source: 'text-table',
    confidence,
    columns,
    rows,
    warnings
  };
}

function collectBlockAttributes(entity: CadEntity, block: CadBlock | undefined, warnings: CadBomWarning[]): Record<string, string> {
  const values = new Map<string, { label: string; value: string; handle?: string; instance: boolean }>();
  const add = (attribute: CadEntity, instance: boolean): void => {
    const label = cleanText(attribute.attributeTag);
    if (!label) return;
    const key = canonicalAttributeKey(label);
    const value = cleanText(attribute.text ?? attribute.value);
    const existing = values.get(key);
    if (existing?.instance && instance && existing.handle && existing.handle !== attribute.handle) {
      warnings.push({
        code: 'duplicate-attribute',
        source: 'block-attributes',
        blockName: entity.blockName,
        handle: entity.handle,
        message: `Duplicate attribute tag ${label} on block ${entity.blockName ?? entity.name ?? '(unnamed)'}. The last instance value is used.`
      });
    }
    if (!existing || instance || value) values.set(key, { label: existing?.label ?? label, value, handle: attribute.handle, instance });
  };
  for (const definition of block?.entities ?? []) if (/^ATTDEF$/i.test(definition.type)) add(definition, false);
  const seenHandles = new Set<string>();
  for (const attribute of entity.attribs ?? []) {
    if (attribute.handle && seenHandles.has(attribute.handle)) continue;
    if (attribute.handle) seenHandles.add(attribute.handle);
    add(attribute, true);
  }
  return Object.fromEntries([...values.values()].map(({ label, value }) => [label, value]));
}

function flattenXData(group: CadXData): Record<string, CadDataScalar> {
  const result: Record<string, CadDataScalar> = {};
  const visit = (value: CadDataValue, path: string): void => {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      addFlatValue(result, path, value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}.${index + 1}`));
      return;
    }
    for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`);
  };
  group.entries.forEach((entry, index) => {
    const label = cleanText(entry.name) || (entry.code !== undefined ? String(entry.code) : `Value ${index + 1}`);
    visit(entry.value, label);
  });
  return result;
}

function addFlatValue(record: Record<string, CadDataScalar>, baseKey: string, value: CadDataScalar): void {
  let key = baseKey;
  let suffix = 2;
  while (key in record) key = `${baseKey} ${suffix++}`;
  record[key] = value;
}

function documentEntities(document: CadDocument, includePaperSpace: boolean): CadEntity[] {
  const entities = [...document.entities];
  if (includePaperSpace) for (const page of document.pages ?? []) entities.push(...page.entities);
  return uniqueEntities(entities);
}

function allDocumentEntities(document: CadDocument, includePaperSpace: boolean): CadEntity[] {
  const entities = documentEntities(document, includePaperSpace);
  const seenBlocks = new Set<CadBlock>();
  for (const block of Object.values(document.blocks)) {
    if (seenBlocks.has(block)) continue;
    seenBlocks.add(block);
    entities.push(...block.entities);
  }
  return uniqueEntities(entities);
}

function uniqueEntities(entities: CadEntity[]): CadEntity[] {
  const result: CadEntity[] = [];
  const handles = new Set<string>();
  const objects = new Set<CadEntity>();
  for (const entity of entities) {
    if (objects.has(entity)) continue;
    objects.add(entity);
    const handle = cleanText(entity.handle);
    if (handle && handles.has(handle.toLocaleUpperCase())) continue;
    if (handle) handles.add(handle.toLocaleUpperCase());
    result.push(entity);
  }
  return result;
}

function isEntityIncluded(entity: CadEntity, options: ResolvedBomOptions): boolean {
  if (!options.includeInvisible && entity.isVisible === false) return false;
  if (!options.includePaperSpace && entity.isInPaperSpace === true) return false;
  return true;
}

function consumeEntity(context: ExtractionContext, source: CadBomSourceKind, entity: CadEntity): boolean {
  if (context.seenEntities.has(entity)) return true;
  context.seenEntities.add(entity);
  context.visitedEntities += 1;
  if (context.visitedEntities <= context.options.maxEntities) return true;
  if (!context.warnings.some((warning) => warning.code === 'max-entities')) {
    context.warnings.push({ code: 'max-entities', source, message: `BOM traversal stopped at ${context.options.maxEntities.toLocaleString()} unique entities.` });
  }
  context.stopped = true;
  return false;
}

function lookupBlock(blocks: Record<string, CadBlock>, name: string): CadBlock | undefined {
  return blocks[name] ?? blocks[name.toLocaleLowerCase()] ?? Object.values(blocks).find((block) => block.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0);
}

function isInfrastructureBlock(name: string): boolean {
  return /^\*?(MODEL|PAPER)_SPACE(?:\d+)?$/i.test(name) || /^\$(MODEL|PAPER)_SPACE/i.test(name);
}

function isDynamicAnonymousBlock(name: string): boolean {
  return /^\*U/i.test(name);
}

function safeMultiplicity(rows: number | undefined, columns: number | undefined): number {
  return safeQuantity(normalizeQuantity(rows), normalizeQuantity(columns));
}

function safeQuantity(left: number, right: number, add = false): number {
  const safeLeft = normalizeQuantity(left);
  const safeRight = normalizeQuantity(right);
  if (add) return safeQuantitySum(safeLeft, safeRight);
  if (safeLeft > Number.MAX_SAFE_INTEGER / safeRight) return Number.MAX_SAFE_INTEGER;
  return safeLeft * safeRight;
}

function safeQuantitySum(left: number, right: number): number {
  const safeLeft = normalizeNonNegativeQuantity(left);
  const safeRight = normalizeNonNegativeQuantity(right);
  return safeLeft > Number.MAX_SAFE_INTEGER - safeRight
    ? Number.MAX_SAFE_INTEGER
    : safeLeft + safeRight;
}

function normalizeQuantity(value: number | undefined): number {
  if (!Number.isFinite(value)) return value === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : 1;
  return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value!)));
}

function normalizeNonNegativeQuantity(value: number): number {
  if (!Number.isFinite(value)) return value === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : 0;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)));
}

function canonicalAttributeKey(value: string): string {
  return value.trim().toLocaleUpperCase();
}

function canonicalAttributeRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record)
    .map(([key, value]) => [canonicalAttributeKey(key), value.trim()] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
}

function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableKey(item)}`).join(',')}}`;
}

function slugKey(value: string): string {
  const normalized = value.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  return normalized || 'column';
}

function uniqueColumnKey(base: string, used: Set<string>): string {
  let key = base;
  let suffix = 2;
  while (used.has(key)) key = `${base}_${suffix++}`;
  used.add(key);
  return key;
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function isValidTableCoordinate(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TABLE_COORDINATE;
}

function cellDisplayValue(cell: CadTableCell | undefined): string {
  if (!cell) return '';
  return cleanText(cell.text) || cleanText(dataValueToScalar(cell.value));
}

function cellScalar(cell: CadTableCell | undefined): CadDataScalar {
  if (!cell) return '';
  const scalar = dataValueToScalar(cell.value);
  return scalar === '' ? textToScalar(cell.text) : scalar;
}

function likelyHeaderRow(header: Map<number, CadTableCell>, bodies: Array<Map<number, CadTableCell>>): boolean {
  const values = [...header.values()].map(cellDisplayValue).filter(Boolean);
  if (values.length < 2 || new Set(values.map((value) => value.toLocaleUpperCase())).size !== values.length) return false;
  const headerText = values.filter((value) => typeof textToScalar(value) === 'string').length / values.length;
  const bodyValues = bodies.slice(0, 12).flatMap((row) => [...row.values()].map(cellScalar)).filter((value) => value !== '');
  const bodyTyped = bodyValues.filter((value) => typeof value === 'number' || typeof value === 'boolean').length / Math.max(1, bodyValues.length);
  return headerText >= 0.8 && (bodyTyped >= 0.15 || values.some(looksLikeBomHeader));
}

function headerLikelihood(header: CadDataScalar[], body: CadDataScalar[]): number {
  const nonEmpty = header.filter((value) => value !== '');
  if (nonEmpty.length < 2) return 0;
  const unique = new Set(nonEmpty.map((value) => String(value).toLocaleUpperCase())).size / nonEmpty.length;
  const stringRatio = nonEmpty.filter((value) => typeof value === 'string').length / nonEmpty.length;
  const known = nonEmpty.filter((value) => looksLikeBomHeader(String(value))).length / nonEmpty.length;
  const bodyTyped = body.filter((value) => value !== '' && (typeof value === 'number' || typeof value === 'boolean')).length / Math.max(1, body.filter((value) => value !== '').length);
  return Math.min(1, unique * 0.25 + stringRatio * 0.25 + known * 0.3 + bodyTyped * 0.2);
}

function looksLikeBomHeader(value: string): boolean {
  return /^(item|part|part\s*no|number|no\.?|name|description|material|qty|quantity|count|unit|规格|型号|名称|材料|数量|序号|代号|图号)$/i.test(value.trim());
}

function inferColumnType(values: CadDataScalar[]): CadBomColumn['dataType'] {
  const types = new Set(values.filter((value) => value !== '' && value !== null).map((value) => typeof value));
  if (types.size === 0 || (types.size === 1 && types.has('string'))) return 'string';
  if (types.size === 1 && types.has('number')) return 'number';
  if (types.size === 1 && types.has('boolean')) return 'boolean';
  return 'mixed';
}

function inferDataValueColumnType(values: CadDataValue[], limit: number): CadBomColumn['dataType'] {
  const types = new Set<string>();
  const length = Math.min(values.length, limit);
  for (let index = 0; index < length; index += 1) {
    const value = dataValueToScalar(values[index]);
    if (value !== '' && value !== null) types.add(typeof value);
    if (types.size > 1) return 'mixed';
  }
  if (types.size === 0 || types.has('string')) return 'string';
  if (types.has('number')) return 'number';
  if (types.has('boolean')) return 'boolean';
  return 'mixed';
}

function dataValueToScalar(value: CadDataValue | undefined): CadDataScalar {
  if (value === undefined || value === null) return value ?? '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textToScalar(value: string): CadDataScalar {
  const text = cleanText(value);
  if (!text) return '';
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  if (/^(true|false)$/i.test(text)) return text.toLocaleLowerCase() === 'true';
  return text;
}

function normalizeCadText(value: string | undefined): string {
  return cleanText(value).replace(/\\P/gi, ' ').replace(/\{\\[^;{}]+;([^{}]*)\}/g, '$1').replace(/%%[dpc]/gi, ' ').replace(/\s+/g, ' ').trim();
}

function joinTextCells(cells: TextCandidate[] | undefined): string {
  return (cells ?? []).sort((left, right) => left.x - right.x).map((cell) => cell.text).join(' ').trim();
}

function isNearlyHorizontal(rotation: number | undefined): boolean {
  if (!Number.isFinite(rotation)) return true;
  const normalized = Math.abs(Number(rotation) % Math.PI);
  return Math.min(normalized, Math.abs(Math.PI - normalized)) <= 0.06;
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function handleEquals(left: string | undefined, right: string | undefined): boolean {
  return !!left && !!right && left.trim().toLocaleUpperCase() === right.trim().toLocaleUpperCase();
}

function cleanText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function positiveFinite(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.trunc(number))) : fallback;
}

function dedupeWarnings(warnings: CadBomWarning[]): CadBomWarning[] {
  const result: CadBomWarning[] = [];
  const seen = new Set<string>();
  for (const warning of warnings) {
    const key = [warning.code, warning.source ?? '', warning.handle ?? '', warning.blockName ?? '', warning.message].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(warning);
  }
  return result;
}

function quoteCsvCell(value: CadDataScalar, delimiter: string, escapeFormulas: boolean): string {
  let text = value === null ? '' : String(value);
  if (escapeFormulas && /^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
  if (text.includes('"')) text = text.replace(/"/g, '""');
  return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text}"` : text;
}
