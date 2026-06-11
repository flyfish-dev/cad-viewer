import type { CadBlock, CadDocument, CadEntity, CadEntityKind, CadLayer, CadPage, CadPoint3D } from './types';

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
    blocks: init.blocks ?? {},
    entities: init.entities ?? [],
    pages: init.pages,
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
    case 'INSERT': return 'insert';
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
  entity.startPoint = pointFromUnknown(raw.startPoint ?? raw.start ?? raw.p0 ?? raw.from) ?? entity.startPoint;
  entity.endPoint = pointFromUnknown(raw.endPoint ?? raw.end ?? raw.p1 ?? raw.to) ?? entity.endPoint;
  entity.center = pointFromUnknown(raw.center ?? raw.centerPoint) ?? entity.center;
  entity.insertionPoint = pointFromUnknown(raw.insertionPoint ?? raw.position ?? raw.location ?? raw.point ?? raw.basePoint) ?? entity.insertionPoint;
  entity.radius = numberOrUndefined(raw.radius) ?? entity.radius;
  entity.startAngle = numberOrUndefined(raw.startAngle ?? raw.start_angle) ?? entity.startAngle;
  entity.endAngle = numberOrUndefined(raw.endAngle ?? raw.end_angle) ?? entity.endAngle;
  entity.majorAxisEndPoint = pointFromUnknown(raw.majorAxisEndPoint ?? raw.majorAxis ?? raw.major) ?? entity.majorAxisEndPoint;
  entity.axisRatio = numberOrUndefined(raw.axisRatio ?? raw.ratio) ?? entity.axisRatio;
  entity.height = numberOrUndefined(raw.height ?? raw.textHeight) ?? entity.height;
  entity.textHeight = numberOrUndefined(raw.textHeight ?? raw.height) ?? entity.textHeight;
  entity.rotation = numberOrUndefined(raw.rotation ?? raw.angle) ?? entity.rotation;
  entity.text = stringOrUndefined(raw.text ?? raw.value ?? raw.string ?? raw.contents) ?? entity.text;
  entity.name = stringOrUndefined(raw.name ?? raw.blockName) ?? entity.name;
  entity.blockName = stringOrUndefined(raw.blockName ?? raw.name) ?? entity.blockName;

  const vertices = normalizePoints(raw.vertices ?? raw.points);
  if (vertices.length > 0) entity.vertices = vertices;
  const controlPoints = normalizePoints(raw.controlPoints ?? raw.control_points);
  if (controlPoints.length > 0) entity.controlPoints = controlPoints;
  const fitPoints = normalizePoints(raw.fitPoints ?? raw.fit_points);
  if (fitPoints.length > 0) entity.fitPoints = fitPoints;
  return entity;
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
