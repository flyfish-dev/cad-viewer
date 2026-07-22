import type {
  CadBlock,
  CadDataValue,
  CadDocument,
  CadEntity,
  CadEntityKind,
  CadLayer,
  CadLineType,
  CadPage,
  CadPoint3D,
  CadTableCell,
  CadTableData,
  CadXData,
  CadXDataEntry
} from './types';

export interface NormalizeCadEntityOptions {
  /** Preserve the parser-owned raw object on entity.raw. This can be very large and may not be structured-clone safe. */
  keepRaw?: boolean;
  /** Copy unknown parser properties onto the normalized entity. Disable inside workers for predictable cloneable payloads. */
  includeUnknownProperties?: boolean;
  /** How to interpret a numeric raw `color` property when the source parser is ambiguous. */
  numericColorMode?: 'auto' | 'aci' | 'rgb';
}

export function createCadDocument(init: Partial<CadDocument> & Pick<CadDocument, 'format'>): CadDocument {
  return {
    format: init.format,
    sourceName: init.sourceName,
    units: init.units,
    header: init.header ?? {},
    layers: init.layers ?? {},
    lineTypes: init.lineTypes ?? {},
    blocks: init.blocks ?? {},
    entities: init.entities ?? [],
    pages: init.pages,
    savedView: init.savedView,
    dataLinks: init.dataLinks,
    dataTables: init.dataTables,
    xrecords: init.xrecords,
    dictionaries: init.dictionaries,
    metadata: init.metadata ?? {},
    warnings: init.warnings ?? [],
    raw: init.raw
  };
}

export function inferEntityKind(type: unknown): CadEntityKind {
  const upper = String(type ?? '').toUpperCase();
  switch (upper) {
    case 'LINE': return 'line';
    case 'CIRCLE': return 'circle';
    case 'ARC': return 'arc';
    case 'LWPOLYLINE':
    case 'POLYLINE':
    case 'POLYLINE_2D':
    case 'POLYLINE2D':
    case 'POLYLINE_3D':
    case 'POLYLINE3D':
    case 'LEADER':
    case 'MULTILEADER': return 'polyline';
    case 'ELLIPSE': return 'ellipse';
    case 'TEXT':
    case 'MTEXT':
    case 'ATTRIB':
    case 'ATTDEF':
    case 'DIMENSION': return 'text';
    case 'POINT': return 'point';
    case 'INSERT':
    case 'MINSERT': return 'insert';
    case 'SOLID':
    case 'TRACE':
    case '3DFACE': return 'solid';
    case 'HATCH': return 'hatch';
    case 'SPLINE': return 'spline';
    case 'PATH':
    case 'XPS_PATH':
    case 'DWF_PATH': return 'path';
    case 'IMAGE':
    case 'RASTER_IMAGE':
    case 'DWF_IMAGE': return 'image';
    case 'VIEWPORT': return 'viewport';
    case 'TABLE':
    case 'ACAD_TABLE':
    case 'ACDBTABLE': return 'table';
    default: return 'unsupported';
  }
}

export function normalizeCadEntity(raw: Record<string, unknown>, forcedType?: string, options: NormalizeCadEntityOptions = {}): CadEntity {
  const type = forcedType ?? String(raw.type ?? raw.entityType ?? raw.objectName ?? 'UNKNOWN').toUpperCase();
  const entity: CadEntity = options.includeUnknownProperties === false
    ? { type, kind: inferEntityKind(type) }
    : { ...raw, type, kind: inferEntityKind(type) } as CadEntity;
  if (options.keepRaw) entity.raw = raw;
  entity.handle = stringOrUndefined(raw.handle ?? raw.id);
  entity.layer = stringOrUndefined(raw.layer ?? raw.layerName);
  entity.lineType = stringOrUndefined(raw.lineType ?? raw.linetype);
  entity.lineTypeScale = numberOrUndefined(raw.lineTypeScale ?? raw.linetypeScale ?? raw.ltscale) ?? entity.lineTypeScale;
  entity.flag = numberOrUndefined(raw.flag ?? raw.flags) ?? entity.flag;
  entity.constantWidth = numberOrUndefined(raw.constantWidth ?? raw.constWidth ?? raw.const_width) ?? entity.constantWidth;
  entity.thickness = numberOrUndefined(raw.thickness) ?? entity.thickness;
  const explicitClosed = raw.isClosed === true || raw.closed === true || raw.shape === true;
  const typeUsesClassicPolylineFlag = /^(POLYLINE|POLYLINE_2D|POLYLINE2D|POLYLINE_3D|POLYLINE3D|SPLINE)$/.test(type);
  const typeUsesLwPolylineFlag = type === 'LWPOLYLINE';
  if (explicitClosed
    || (typeUsesClassicPolylineFlag && (Number(entity.flag ?? 0) & 1) === 1)
    || (typeUsesLwPolylineFlag && (Number(entity.flag ?? 0) & 0x200) === 0x200)) {
    entity.isClosed = true;
  }

  const numericColorMode = options.numericColorMode ?? 'auto';
  const rawColorNumber = numberOrUndefined(raw.color);
  const explicitAci = numberOrUndefined(raw.colorIndex ?? raw.colorNumber ?? raw.aci ?? raw.aciColor ?? raw.color_index);
  entity.colorIndex = explicitAci ?? (numericColorMode !== 'rgb' && rawColorNumber !== undefined && Math.abs(rawColorNumber) <= 257 ? rawColorNumber : undefined);

  const explicitTrueColor = raw.trueColor ?? raw.true_color ?? raw.truecolor ?? raw.colorRGB ?? raw.colorRgb ?? raw.rgbColor ?? raw.rgb;
  const rawColorLooksRgb = rawColorNumber !== undefined && rawColorNumber >= 0 && rawColorNumber <= 0xffffff && (numericColorMode === 'rgb' || (numericColorMode === 'auto' && Math.abs(rawColorNumber) > 257));
  entity.trueColor = (explicitTrueColor ?? (rawColorLooksRgb ? rawColorNumber : undefined)) as CadEntity['trueColor'];
  if (typeof raw.color === 'string' || typeof raw.color === 'number') entity.color = raw.color as string | number;
  entity.colorNumber = numberOrUndefined(raw.colorNumber) ?? entity.colorNumber;
  entity.colorName = stringOrUndefined(raw.colorName ?? raw.color_name) ?? entity.colorName;
  entity.fillColor = (raw.fillColor ?? raw.fill_color) as CadEntity['fillColor'];
  entity.fillColorIndex = numberOrUndefined(raw.fillColorIndex ?? raw.fill_color_index ?? raw.fillColorNumber) ?? entity.fillColorIndex;
  entity.opacity = numberOrUndefined(raw.opacity ?? raw.alpha) ?? entity.opacity;
  entity.lineweight = numberOrUndefined(raw.lineweight ?? raw.lineWeight);
  entity.isVisible = raw.isVisible === false || raw.visible === false ? false : true;
  const nestedText = objectOrUndefined(raw.text);
  entity.startPoint = pointFromUnknown(raw.startPoint ?? nestedText?.startPoint ?? raw.start ?? raw.p0 ?? raw.from) ?? entity.startPoint;
  entity.endPoint = pointFromUnknown(raw.endPoint ?? nestedText?.endPoint ?? raw.end ?? raw.p1 ?? raw.to) ?? entity.endPoint;
  entity.center = pointFromUnknown(raw.center ?? raw.centerPoint) ?? entity.center;
  entity.insertionPoint = pointFromUnknown(raw.insertionPoint ?? nestedText?.startPoint ?? raw.position ?? raw.location ?? raw.point ?? raw.basePoint) ?? entity.insertionPoint;
  entity.radius = numberOrUndefined(raw.radius) ?? entity.radius;
  entity.startAngle = numberOrUndefined(raw.startAngle ?? raw.start_angle) ?? entity.startAngle;
  entity.endAngle = numberOrUndefined(raw.endAngle ?? raw.end_angle) ?? entity.endAngle;
  entity.majorAxisEndPoint = pointFromUnknown(raw.majorAxisEndPoint ?? raw.majorAxis ?? raw.major) ?? entity.majorAxisEndPoint;
  entity.axisRatio = numberOrUndefined(raw.axisRatio ?? raw.ratio) ?? entity.axisRatio;
  entity.height = numberOrUndefined(raw.height ?? raw.textHeight ?? nestedText?.textHeight) ?? entity.height;
  entity.textHeight = numberOrUndefined(raw.textHeight ?? raw.height ?? nestedText?.textHeight) ?? entity.textHeight;
  entity.xScale = numberOrUndefined(raw.xScale ?? raw.widthFactor ?? nestedText?.xScale) ?? entity.xScale;
  entity.generationFlag = numberOrUndefined(raw.generationFlag ?? raw.textGenerationFlag ?? nestedText?.generationFlag) ?? entity.generationFlag;
  entity.halign = numberOrUndefined(raw.halign ?? raw.horizontalAlignment ?? nestedText?.halign) ?? entity.halign;
  entity.valign = numberOrUndefined(raw.valign ?? raw.verticalAlignment ?? nestedText?.valign) ?? entity.valign;
  entity.extrusionDirection = pointFromUnknown(raw.extrusionDirection ?? raw.extrusion ?? nestedText?.extrusionDirection) ?? entity.extrusionDirection;
  entity.rotation = numberOrUndefined(raw.rotation ?? raw.angle ?? nestedText?.rotation) ?? entity.rotation;
  entity.text = stringOrUndefined(nestedText?.text ?? raw.text ?? raw.value ?? raw.string ?? raw.contents ?? raw.defaultValue ?? raw.default_value) ?? entity.text;
  entity.value = stringOrUndefined(raw.value ?? nestedText?.text ?? raw.text ?? raw.string ?? raw.contents ?? raw.defaultValue ?? raw.default_value) ?? entity.value;
  entity.name = stringOrUndefined(raw.name ?? raw.blockName) ?? entity.name;
  entity.blockName = stringOrUndefined(raw.blockName ?? raw.name) ?? entity.blockName;
  entity.effectiveBlockName = stringOrUndefined(raw.effectiveBlockName ?? raw.effectiveName ?? raw.dynamicBlockName ?? raw.originalBlockName) ?? entity.effectiveBlockName;
  entity.extensionDictionaryHandle = handleString(raw.extensionDictionaryHandle ?? raw.ownerDictionaryHardId ?? raw.ownerdictionaryHardId ?? raw.xdicobjhandle) ?? entity.extensionDictionaryHandle;
  entity.ownerBlockRecordHandle = handleString(raw.ownerBlockRecordHandle ?? raw.ownerBlockRecordSoftId ?? raw.ownerHandle) ?? entity.ownerBlockRecordHandle;
  entity.attributeTag = stringOrUndefined(raw.attributeTag ?? raw.tag ?? raw.tagString ?? raw.attrTag) ?? entity.attributeTag;
  entity.attributePrompt = stringOrUndefined(raw.attributePrompt ?? raw.prompt ?? raw.promptString) ?? entity.attributePrompt;
  entity.attributeFlags = numberOrUndefined(raw.attributeFlags ?? raw.flags ?? raw.flag) ?? entity.attributeFlags;
  if (type === 'INSERT' || type === 'MINSERT') {
    entity.insertRowCount = positiveIntegerOrUndefined(raw.insertRowCount ?? raw.rowCount ?? raw.numRows ?? raw.num_rows) ?? entity.insertRowCount;
    entity.insertColumnCount = positiveIntegerOrUndefined(raw.insertColumnCount ?? raw.columnCount ?? raw.numColumns ?? raw.numCols ?? raw.num_cols) ?? entity.insertColumnCount;
    entity.insertRowSpacing = numberOrUndefined(raw.insertRowSpacing ?? raw.rowSpacing ?? raw.row_spacing) ?? entity.insertRowSpacing;
    entity.insertColumnSpacing = numberOrUndefined(raw.insertColumnSpacing ?? raw.columnSpacing ?? raw.col_spacing) ?? entity.insertColumnSpacing;
  }
  const xdata = normalizeCadXData(raw.xdata ?? raw.extendedData ?? raw.xData);
  if (xdata.length > 0) entity.xdata = xdata;
  if (type === 'INSERT' || type === 'MINSERT') {
    const scale = pointFromUnknown(raw.scale);
    if (scale) {
      entity.scale = scale;
    } else {
      const scaleX = numberOrUndefined(raw.scaleX ?? raw.xScale);
      const scaleY = numberOrUndefined(raw.scaleY ?? raw.yScale) ?? scaleX;
      const scaleZ = numberOrUndefined(raw.scaleZ ?? raw.zScale);
      if (scaleX !== undefined && scaleY !== undefined) {
        entity.scale = scaleZ === undefined ? { x: scaleX, y: scaleY } : { x: scaleX, y: scaleY, z: scaleZ };
      }
    }
  }

  const vertices = normalizePoints(raw.vertices ?? raw.points);
  if (vertices.length > 0) entity.vertices = vertices;
  const controlPoints = normalizePoints(raw.controlPoints ?? raw.control_points);
  if (controlPoints.length > 0) entity.controlPoints = controlPoints;
  const fitPoints = normalizePoints(raw.fitPoints ?? raw.fit_points);
  if (fitPoints.length > 0) entity.fitPoints = fitPoints;
  const rawAttribs = raw.attribs ?? raw.attributes ?? raw.attributeEntities;
  if (Array.isArray(rawAttribs)) {
    entity.attribs = rawAttribs
      .filter((attribute): attribute is Record<string, unknown> => !!attribute && typeof attribute === 'object')
      .map((attribute) => normalizeCadEntity(attribute, undefined, options));
  }
  if (type === 'TABLE' || type === 'ACAD_TABLE' || type === 'ACDBTABLE') {
    entity.table = normalizeCadTableData(raw);
  }
  return entity;
}

export function normalizeCadTableData(raw: Record<string, unknown>): CadTableData {
  const linkedMetadata = objectOrUndefined(raw.ldata ?? raw.linkedData);
  const linkedData = objectOrUndefined(raw.tdata ?? raw.linkedTableData);
  const rawRows = positiveIntegerOrUndefined(raw.rowCount ?? raw.rowsCount ?? raw.numRows ?? raw.num_rows ?? linkedData?.numRows ?? linkedData?.num_rows) ?? 0;
  const rawColumns = positiveIntegerOrUndefined(raw.columnCount ?? raw.columnsCount ?? raw.numColumns ?? raw.numCols ?? raw.num_cols ?? linkedData?.numColumns ?? linkedData?.numCols ?? linkedData?.num_cols) ?? 0;
  const sourceCells = normalizeRawCellArray(raw.cells ?? raw.tableCells ?? raw.cellValues ?? linkedData?.rows ?? raw.data);
  const inferredColumns = rawColumns || inferTableColumnCount(sourceCells);
  const inferredRows = rawRows || (inferredColumns > 0 ? Math.ceil(sourceCells.length / inferredColumns) : 0);
  const cells: CadTableCell[] = sourceCells.map(({ cell, index }) => normalizeCadTableCell(cell, index, inferredColumns));
  return {
    name: stringOrUndefined(raw.tableName ?? raw.name ?? linkedMetadata?.name ?? linkedMetadata?.description),
    rowCount: inferredRows,
    columnCount: inferredColumns,
    cells,
    rowHeights: numberArray(raw.rowHeights ?? raw.rowHeightArr ?? raw.row_heights),
    columnWidths: numberArray(raw.columnWidths ?? raw.columnWidthArr ?? raw.col_widths),
    dataLinkHandle: handleString(raw.dataLinkHandle ?? raw.dataLink ?? raw.data_link),
    titleSuppressed: booleanOrUndefined(raw.titleSuppressed ?? raw.title_suppressed),
    headerSuppressed: booleanOrUndefined(raw.headerSuppressed ?? raw.header_suppressed)
  };
}

export function pointFromUnknown(value: unknown): CadPoint3D | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const x = Number(record.x ?? record.X ?? record[0]);
  const y = Number(record.y ?? record.Y ?? record[1]);
  const zCandidate = record.z ?? record.Z ?? record[2];
  const z = zCandidate === undefined ? undefined : Number(zCandidate);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return Number.isFinite(z) ? { x, y, z } : { x, y };
}

export function normalizePoints(value: unknown): Array<CadPoint3D & { bulge?: number; startWidth?: number; endWidth?: number }> {
  if (!Array.isArray(value)) return [];
  const out: Array<CadPoint3D & { bulge?: number; startWidth?: number; endWidth?: number }> = [];
  for (const item of value) {
    const p = pointFromUnknown(item);
    if (!p) continue;
    const rec = item as Record<string, unknown>;
    const vertex = p as CadPoint3D & { bulge?: number; startWidth?: number; endWidth?: number };
    const bulge = numberOrUndefined(rec.bulge);
    if (bulge !== undefined) vertex.bulge = bulge;
    const startWidth = numberOrUndefined(rec.startWidth ?? rec.start_width);
    if (startWidth !== undefined) vertex.startWidth = startWidth;
    const endWidth = numberOrUndefined(rec.endWidth ?? rec.end_width);
    if (endWidth !== undefined) vertex.endWidth = endWidth;
    out.push(vertex);
  }
  return out;
}

export function summarizeCadDocument(document: CadDocument) {
  const byType: Record<string, number> = {};
  for (const entity of document.entities) {
    const type = String(entity.type ?? 'UNKNOWN').toUpperCase();
    byType[type] = (byType[type] ?? 0) + 1;
  }
  return {
    format: document.format,
    sourceName: document.sourceName,
    entityCount: document.entities.length,
    layerCount: Object.keys(document.layers).length,
    blockCount: Object.keys(document.blocks).length,
    pageCount: document.pages?.length ?? 0,
    byType,
    warnings: [...document.warnings]
  };
}

export function isCadPolylineClosed(entity: CadEntity): boolean {
  if (entity.isClosed === true) return true;
  const type = String(entity.type ?? '').toUpperCase();
  const flag = Number(entity.flag ?? 0);
  const isLightweightPolyline = type === 'LWPOLYLINE';
  const isClassicPolyline = /^(POLYLINE|POLYLINE_2D|POLYLINE2D|POLYLINE_3D|POLYLINE3D)$/.test(type);
  if (isLightweightPolyline && (flag & 0x200) === 0x200) return true;
  if (isClassicPolyline && (flag & 1) === 1) return true;
  if (!isLightweightPolyline && !isClassicPolyline) return false;
  const points = entity.vertices ?? entity.points;
  if (!Array.isArray(points) || points.length < 3) return false;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return false;
  const extent = points.reduce((max, point) => Math.max(max, Math.abs(point.x), Math.abs(point.y)), 1);
  return Math.hypot(first.x - last.x, first.y - last.y) <= Math.max(1e-9, extent * 1e-12);
}

/** Returns an entity's authored polyline width in drawing units. */
export function cadEntityWorldStrokeWidth(entity: CadEntity): number {
  let width = finiteNonNegative(entity.constantWidth);
  for (const vertex of entity.vertices ?? []) {
    width = Math.max(width, finiteNonNegative(vertex.startWidth), finiteNonNegative(vertex.endWidth));
  }
  return width;
}

export function addLayer(target: Record<string, CadLayer>, layer: CadLayer): void {
  if (!layer.name) return;
  target[layer.name] = layer;
  target[layer.name.toLowerCase()] = layer;
}

export function addBlock(target: Record<string, CadBlock>, block: CadBlock): void {
  if (!block.name) return;
  target[block.name] = block;
  target[block.name.toLowerCase()] = block;
}

export function addLineType(target: Record<string, CadLineType>, lineType: CadLineType): void {
  if (!lineType.name) return;
  target[lineType.name] = lineType;
  target[lineType.name.toLowerCase()] = lineType;
  if (lineType.handle) {
    target[lineType.handle] = lineType;
    target[lineType.handle.toLowerCase()] = lineType;
  }
}

export function flattenPages(pages: CadPage[] | undefined): CadEntity[] {
  if (!pages?.length) return [];
  return pages.flatMap((page) => page.entities.map((entity) => ({ ...entity, pageIndex: page.index })));
}

export function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const out = String(value);
  return out.length > 0 ? out : undefined;
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  const number = numberOrUndefined(value);
  if (number === undefined || number <= 0) return undefined;
  return Math.max(1, Math.trunc(number));
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === '0') return false;
  if (value === 1 || value === '1') return true;
  return undefined;
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.map(numberOrUndefined).filter((item): item is number => item !== undefined);
  return numbers.length > 0 ? numbers : undefined;
}

function handleString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return stringOrUndefined(value[3] ?? value[2] ?? value[value.length - 1]);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return stringOrUndefined(record.absolute_ref ?? record.absoluteRef ?? record.handle ?? record.id ?? record.value);
  }
  return stringOrUndefined(value);
}

function normalizeRawCellArray(value: unknown): Array<{ cell: unknown; index: number }> {
  if (!Array.isArray(value)) {
    const record = objectOrUndefined(value);
    const rows = record?.rows ?? record?.values ?? record?.cells;
    return Array.isArray(rows) ? normalizeRawCellArray(rows) : [];
  }
  const result: Array<{ cell: unknown; index: number }> = [];
  let index = 0;
  for (const item of value) {
    if (Array.isArray(item)) {
      for (const cell of item) result.push({ cell, index: index++ });
      continue;
    }
    const record = objectOrUndefined(item);
    const nestedCells = record?.cells ?? record?.values;
    if (Array.isArray(nestedCells) && !('text' in (record ?? {})) && !('value' in (record ?? {}))) {
      for (const cell of nestedCells) result.push({ cell, index: index++ });
      continue;
    }
    result.push({ cell: item, index: index++ });
  }
  return result;
}

function inferTableColumnCount(cells: Array<{ cell: unknown; index: number }>): number {
  let maxColumn = -1;
  for (const { cell } of cells) {
    const record = objectOrUndefined(cell);
    const column = numberOrUndefined(record?.column ?? record?.columnIndex ?? record?.col ?? record?.column_index);
    if (column !== undefined) maxColumn = Math.max(maxColumn, Math.trunc(column));
  }
  return maxColumn >= 0 ? maxColumn + 1 : 0;
}

function normalizeCadTableCell(value: unknown, index: number, columnCount: number): CadTableCell {
  const record = objectOrUndefined(value);
  const rawValue = record ? tableValueFromRecord(record) : normalizeCadDataValue(value);
  const explicitText = record
    ? stringOrUndefined(record.text ?? record.textValue ?? record.text_value ?? record.valueString ?? record.value_string ?? record.displayValue)
    : stringOrUndefined(value);
  const text = explicitText ?? dataValueText(rawValue);
  const row = Math.max(0, Math.trunc(numberOrUndefined(record?.row ?? record?.rowIndex ?? record?.row_index) ?? (columnCount > 0 ? Math.floor(index / columnCount) : index)));
  const column = Math.max(0, Math.trunc(numberOrUndefined(record?.column ?? record?.columnIndex ?? record?.col ?? record?.column_index) ?? (columnCount > 0 ? index % columnCount : 0)));
  const attrText = stringOrUndefined(record?.attrText ?? record?.attributeText);
  const blockAttributes = attrText ? { value: attrText } : normalizeStringRecord(record?.blockAttributes ?? record?.attributes);
  return {
    row,
    column,
    text,
    ...(rawValue !== undefined ? { value: rawValue } : {}),
    ...(stringOrUndefined(record?.dataType ?? record?.typeName) || numberOrUndefined(record?.cellType ?? record?.type) !== undefined
      ? { dataType: stringOrUndefined(record?.dataType ?? record?.typeName) ?? numberOrUndefined(record?.cellType ?? record?.type)! }
      : {}),
    ...(stringOrUndefined(record?.formula ?? record?.expression) ? { formula: stringOrUndefined(record?.formula ?? record?.expression)! } : {}),
    ...(positiveIntegerOrUndefined(record?.rowSpan ?? record?.mergedHeight ?? record?.merged_height_flag) ? { rowSpan: positiveIntegerOrUndefined(record?.rowSpan ?? record?.mergedHeight ?? record?.merged_height_flag)! } : {}),
    ...(positiveIntegerOrUndefined(record?.columnSpan ?? record?.mergedWidth ?? record?.merged_width_flag) ? { columnSpan: positiveIntegerOrUndefined(record?.columnSpan ?? record?.mergedWidth ?? record?.merged_width_flag)! } : {}),
    ...(booleanOrUndefined(record?.isMerged ?? record?.mergedValue ?? record?.is_merged_value) !== undefined ? { isMerged: booleanOrUndefined(record?.isMerged ?? record?.mergedValue ?? record?.is_merged_value)! } : {}),
    ...(numberOrUndefined(record?.textHeight ?? record?.text_height) !== undefined ? { textHeight: numberOrUndefined(record?.textHeight ?? record?.text_height)! } : {}),
    ...(handleString(record?.blockTableRecordId ?? record?.blockRecordHandle ?? record?.block_handle) ? { blockTableRecordId: handleString(record?.blockTableRecordId ?? record?.blockRecordHandle ?? record?.block_handle)! } : {}),
    ...(blockAttributes && Object.keys(blockAttributes).length > 0 ? { blockAttributes } : {})
  };
}

function tableValueFromRecord(record: Record<string, unknown>): CadDataValue | undefined {
  const nested = objectOrUndefined(record.value);
  const candidates = [
    nested?.valueString,
    nested?.value_string,
    nested?.dataString,
    nested?.data_string,
    nested?.dataLong,
    nested?.data_long,
    nested?.dataDouble,
    nested?.data_double,
    nested?.dataDate,
    nested?.data_date,
    nested?.dataPoint,
    nested?.data_point,
    nested?.data3dPoint,
    nested?.data_3dpoint,
    record.rawValue,
    record.value
  ];
  for (const candidate of candidates) {
    const normalized = normalizeCadDataValue(candidate);
    if (normalized !== undefined && normalized !== '') return normalized;
  }
  return undefined;
}

function dataValueText(value: CadDataValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!Array.isArray(value) && typeof value === 'object' && 'x' in value && 'y' in value) {
    const point = value as CadPoint3D;
    return [point.x, point.y, point.z].filter((item) => item !== undefined).join(', ');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  const record = objectOrUndefined(value);
  if (!record) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    const text = stringOrUndefined(item) ?? dataValueText(normalizeCadDataValue(item));
    if (text) result[key] = text;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeCadXData(value: unknown): CadXData[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    if (value.some((item) => objectOrUndefined(item)?.appName !== undefined || objectOrUndefined(item)?.applicationName !== undefined)) {
      return value.flatMap((item) => normalizeCadXData(item));
    }
    const entries = value.map(normalizeCadXDataEntry).filter((item): item is CadXDataEntry => !!item);
    return entries.length > 0 ? [{ entries }] : [];
  }
  const record = objectOrUndefined(value);
  if (!record) return [];
  const appName = stringOrUndefined(record.appName ?? record.applicationName ?? record.app);
  const customStrings = Array.isArray(record.customStrings)
    ? record.customStrings.map((item) => ({ code: 1000, value: item }))
    : undefined;
  const rawEntries = record.entries ?? record.value ?? record.values ?? record.data ?? customStrings;
  if (Array.isArray(rawEntries)) {
    const entries = rawEntries.map(normalizeCadXDataEntry).filter((item): item is CadXDataEntry => !!item);
    return entries.length > 0 ? [{ appName, entries }] : [];
  }
  if (appName) {
    const entry = normalizeCadXDataEntry(rawEntries);
    return entry ? [{ appName, entries: [entry] }] : [];
  }
  const groups: CadXData[] = [];
  for (const [name, entriesValue] of Object.entries(record)) {
    const entries = (Array.isArray(entriesValue) ? entriesValue : [entriesValue])
      .map(normalizeCadXDataEntry)
      .filter((item): item is CadXDataEntry => !!item);
    if (entries.length > 0) groups.push({ appName: name, entries });
  }
  return groups;
}

function normalizeCadXDataEntry(value: unknown): CadXDataEntry | undefined {
  const record = objectOrUndefined(value);
  if (record) {
    const nested = normalizeCadDataValue(record.value ?? record.data ?? record.text ?? record);
    if (nested === undefined) return undefined;
    return {
      ...(numberOrUndefined(record.code ?? record.groupCode) !== undefined ? { code: numberOrUndefined(record.code ?? record.groupCode)! } : {}),
      ...(stringOrUndefined(record.name ?? record.key) ? { name: stringOrUndefined(record.name ?? record.key)! } : {}),
      value: nested
    };
  }
  const normalized = normalizeCadDataValue(value);
  return normalized === undefined ? undefined : { value: normalized };
}

export function normalizeCadDataValue(value: unknown, depth = 0, seen = new WeakSet<object>()): CadDataValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, Math.min(value.byteLength, 65536)));
  if (depth >= 12 || !value || typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.slice(0, 100000).map((item) => normalizeCadDataValue(item, depth + 1, seen)).filter((item): item is CadDataValue => item !== undefined);
    seen.delete(value);
    return out;
  }
  const out: Record<string, CadDataValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 10000)) {
    const normalized = normalizeCadDataValue(item, depth + 1, seen);
    if (normalized !== undefined) out[key] = normalized;
  }
  seen.delete(value);
  return out;
}

function finiteNonNegative(value: unknown): number {
  const number = Math.abs(Number(value));
  return Number.isFinite(number) ? number : 0;
}
