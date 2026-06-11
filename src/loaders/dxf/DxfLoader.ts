import { addBlock, addLayer, createCadDocument, normalizeCadEntity, numberOrUndefined, pointFromUnknown, stringOrUndefined } from '../../core/entity';
import { detectCadFormat, extensionOf, readInputBytes } from '../../core/format';
import { degreesToRadians } from '../../core/geometry';
import type { CadBlock, CadDocument, CadEntity, CadLayer, CadLoadInput, CadLoadOptions, CadLoadResult, CadLoader, CadPoint3D } from '../../core/types';

export class DxfLoader implements CadLoader {
  readonly id = 'dxf';
  readonly label = 'DXF / JavaScript parser';
  readonly formats = ['dxf'] as const;
  private readonly defaults: CadLoadOptions;

  constructor(defaults: CadLoadOptions = {}) {
    this.defaults = defaults;
  }

  accepts(input: CadLoadInput, bytes?: Uint8Array): boolean {
    return extensionOf(input) === 'dxf' || detectCadFormat(input, bytes) === 'dxf';
  }

  async load(input: CadLoadInput, options: CadLoadOptions = {}): Promise<CadLoadResult> {
    void { ...this.defaults, ...options };
    const started = performance.now();
    const bytes = await readInputBytes(input);
    const text = decodeDxfText(bytes);
    const warnings: string[] = [];
    let parsed: unknown;
    try {
      parsed = await parseWithDxfParser(text);
    } catch (error) {
      warnings.push(`dxf-parser failed, using built-in fallback parser: ${error instanceof Error ? error.message : String(error)}`);
      parsed = parseDxfFallback(text);
    }
    const document = normalizeDxfDatabase(parsed, input.fileName ?? input.file?.name, warnings);
    const elapsedMs = performance.now() - started;
    return { document, raw: parsed, bytes: bytes.byteLength, elapsedMs, format: 'dxf', warnings: document.warnings };
  }
}

async function parseWithDxfParser(text: string): Promise<unknown> {
  const module = await import('dxf-parser') as { default?: new () => { parseSync(text: string): unknown }; DxfParser?: new () => { parseSync(text: string): unknown } };
  const Parser = module.default ?? module.DxfParser;
  if (!Parser) throw new Error('dxf-parser did not expose a parser constructor.');
  return new Parser().parseSync(text);
}

export function normalizeDxfDatabase(parsed: unknown, sourceName?: string, warnings: string[] = []): CadDocument {
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  const layers = extractDxfLayers(record);
  const blocks = extractDxfBlocks(record);
  const rawEntities = Array.isArray(record.entities) ? record.entities : [];
  const entities = rawEntities
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => normalizeDxfEntity(item));

  const document = createCadDocument({
    format: 'dxf',
    sourceName,
    header: record.header && typeof record.header === 'object' ? record.header as Record<string, unknown> : {},
    layers,
    blocks,
    entities,
    metadata: { parser: 'dxf-parser + cad-viewer normalizer' },
    warnings,
    raw: parsed
  });
  if (entities.length === 0) document.warnings.push('DXF file did not expose any ENTITIES.');
  return document;
}

function normalizeDxfEntity(raw: Record<string, unknown>): CadEntity {
  const type = String(raw.type ?? raw.entityType ?? 'UNKNOWN').toUpperCase();
  const entity = normalizeCadEntity(raw, type);
  const rawColorNumber = numberOrUndefined(raw.colorIndex ?? raw.colorNumber ?? raw.aci);
  const rawColor = numberOrUndefined(raw.color);
  entity.colorIndex = rawColorNumber ?? (rawColor !== undefined && Math.abs(rawColor) <= 257 ? rawColor : undefined);
  entity.trueColor = (raw.trueColor ?? raw.true_color ?? raw.colorRGB ?? raw.trueColorValue ?? (rawColor !== undefined && Math.abs(rawColor) > 257 ? rawColor : undefined)) as CadEntity['trueColor'];
  entity.layer = stringOrUndefined(raw.layer ?? raw.layerName) ?? '0';
  entity.isClosed = Boolean(raw.shape ?? raw.closed ?? raw.isClosed) || ((Number(raw.flag ?? raw.flags ?? 0) & 1) === 1);

  if (type === 'LINE') {
    entity.startPoint = pointFromUnknown(raw.startPoint ?? { x: raw.x1 ?? raw.x, y: raw.y1 ?? raw.y, z: raw.z1 ?? raw.z }) ?? entity.startPoint;
    entity.endPoint = pointFromUnknown(raw.endPoint ?? { x: raw.x2, y: raw.y2, z: raw.z2 }) ?? entity.endPoint;
  }
  if (type === 'TEXT' || type === 'MTEXT' || type === 'ATTRIB' || type === 'ATTDEF') {
    entity.insertionPoint = pointFromUnknown(raw.startPoint ?? raw.position ?? raw.insertionPoint) ?? entity.insertionPoint;
    entity.text = stringOrUndefined(raw.text ?? raw.string ?? raw.value) ?? entity.text;
    entity.textHeight = numberOrUndefined(raw.textHeight ?? raw.height) ?? entity.textHeight;
    entity.rotation = normalizeRotation(raw.rotation ?? raw.angle);
  }
  if (type === 'ARC' || type === 'ELLIPSE') {
    entity.startAngle = normalizeAngle(raw.startAngle ?? raw.start_angle);
    entity.endAngle = normalizeAngle(raw.endAngle ?? raw.end_angle);
  }
  if (type === 'INSERT') {
    entity.blockName = stringOrUndefined(raw.name ?? raw.blockName) ?? entity.blockName;
    entity.insertionPoint = pointFromUnknown(raw.position ?? raw.insertionPoint ?? raw.point) ?? entity.insertionPoint;
    const sx = numberOrUndefined(raw.xScale ?? raw.scaleX ?? raw.xscale);
    const sy = numberOrUndefined(raw.yScale ?? raw.scaleY ?? raw.yscale);
    const sz = numberOrUndefined(raw.zScale ?? raw.scaleZ ?? raw.zscale);
    if (sx !== undefined || sy !== undefined || sz !== undefined) entity.scale = { x: sx ?? 1, y: sy ?? sx ?? 1, z: sz ?? 1 };
    entity.rotation = normalizeRotation(raw.rotation ?? raw.angle);
  }
  if (type === 'SPLINE') {
    const control = normalizeControlPoints(raw.controlPoints ?? raw.control_points ?? raw.points);
    if (control.length) entity.controlPoints = control;
    const fit = normalizeControlPoints(raw.fitPoints ?? raw.fit_points);
    if (fit.length) entity.fitPoints = fit;
  }
  if (type === 'HATCH') {
    entity.loops = normalizeHatchLoops(raw);
    entity.fillColorIndex = entity.colorIndex;
  }
  if (type === 'SOLID' || type === 'TRACE' || type === '3DFACE') {
    entity.vertices = normalizeSolidVertices(raw);
    entity.fillColorIndex = entity.colorIndex;
  }
  return entity;
}

function extractDxfLayers(raw: Record<string, unknown>): Record<string, CadLayer> {
  const result: Record<string, CadLayer> = {};
  const tables = raw.tables as Record<string, unknown> | undefined;
  const layerTable = raw.layers ?? tables?.layer ?? tables?.LAYER ?? tables?.layers;
  const candidates = expandRecords(layerTable);
  for (const item of candidates) {
    const rec = item as Record<string, unknown>;
    const name = stringOrUndefined(rec.name ?? rec.layerName);
    if (!name) continue;
    addLayer(result, {
      name,
      color: (rec.color ?? rec.colorNumber ?? rec.colorIndex) as string | number | undefined,
      colorIndex: numberOrUndefined(rec.colorNumber ?? rec.colorIndex ?? rec.color),
      lineType: stringOrUndefined(rec.lineType ?? rec.linetype),
      isVisible: Number(rec.colorNumber ?? rec.colorIndex ?? rec.color ?? 1) >= 0,
      isFrozen: Boolean(rec.frozen),
      isLocked: Boolean(rec.locked),
      raw: rec
    });
  }
  if (!result['0']) addLayer(result, { name: '0', colorIndex: 7, isVisible: true });
  return result;
}

function extractDxfBlocks(raw: Record<string, unknown>): Record<string, CadBlock> {
  const result: Record<string, CadBlock> = {};
  const blocks = raw.blocks;
  if (!blocks || typeof blocks !== 'object') return result;
  if (Array.isArray(blocks)) {
    for (const block of blocks) addDxfBlock(result, block);
  } else {
    for (const [name, block] of Object.entries(blocks as Record<string, unknown>)) addDxfBlock(result, block, name);
  }
  return result;
}

function addDxfBlock(target: Record<string, CadBlock>, blockValue: unknown, fallbackName?: string): void {
  if (!blockValue || typeof blockValue !== 'object') return;
  const rec = blockValue as Record<string, unknown>;
  const name = stringOrUndefined(rec.name ?? rec.blockName ?? fallbackName);
  if (!name) return;
  const rawEntities = Array.isArray(rec.entities) ? rec.entities : [];
  const entities = rawEntities
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => normalizeDxfEntity(item));
  addBlock(target, { name, basePoint: pointFromUnknown(rec.basePoint ?? rec.position) ?? { x: 0, y: 0 }, entities, raw: rec });
}

function expandRecords(value: unknown): unknown[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return [];
  const rec = value as Record<string, unknown>;
  if (Array.isArray(rec.entries)) return rec.entries;
  if (Array.isArray(rec.records)) return rec.records;
  if (Array.isArray(rec.layers)) return rec.layers;
  return Object.values(rec).filter((x) => x && typeof x === 'object');
}

function normalizeControlPoints(value: unknown): CadPoint3D[] {
  if (!Array.isArray(value)) return [];
  return value.map(pointFromUnknown).filter((p): p is CadPoint3D => !!p);
}

function normalizeSolidVertices(raw: Record<string, unknown>): CadPoint3D[] {
  const direct = normalizeControlPoints(raw.vertices ?? raw.points);
  if (direct.length) return direct;
  const out: CadPoint3D[] = [];
  for (let i = 0; i < 4; i++) {
    const point = pointFromUnknown({ x: raw[`x${i}`] ?? raw[`x${i + 1}`], y: raw[`y${i}`] ?? raw[`y${i + 1}`], z: raw[`z${i}`] ?? raw[`z${i + 1}`] });
    if (point) out.push(point);
  }
  return out;
}

function normalizeHatchLoops(raw: Record<string, unknown>): CadEntity['loops'] {
  const loops = raw.boundaryLoops ?? raw.loops ?? raw.paths;
  if (!Array.isArray(loops)) return undefined;
  return loops.map((loop) => {
    const rec = loop as Record<string, unknown>;
    const vertices = normalizeControlPoints(rec.vertices ?? rec.points);
    return { vertices, isClosed: true };
  }).filter((loop) => loop.vertices && loop.vertices.length > 0);
}

function normalizeRotation(value: unknown): number | undefined {
  const n = numberOrUndefined(value);
  if (n === undefined) return undefined;
  return Math.abs(n) > Math.PI * 2 + 1e-6 ? degreesToRadians(n) : n;
}

function normalizeAngle(value: unknown): number | undefined {
  const n = numberOrUndefined(value);
  if (n === undefined) return undefined;
  return Math.abs(n) > Math.PI * 2 + 1e-6 ? degreesToRadians(n) : n;
}

function decodeDxfText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (utf8.includes('SECTION')) return utf8;
  return new TextDecoder('iso-8859-1', { fatal: false }).decode(bytes);
}

interface DxfPair { code: number; value: string }

function parseDxfFallback(text: string): { header: Record<string, unknown>; tables: Record<string, unknown>; entities: CadEntity[]; blocks: Record<string, unknown> } {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const pairs: DxfPair[] = [];
  for (let i = 0; i < lines.length - 1; i += 2) {
    const code = Number(lines[i]?.trim());
    const value = lines[i + 1] ?? '';
    if (Number.isFinite(code)) pairs.push({ code, value: value.trimEnd() });
  }
  const entities: CadEntity[] = [];
  const blocks: Record<string, unknown> = {};
  let section = '';
  let current: DxfPair[] = [];
  let polyline: CadEntity | undefined;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (pair.code === 0 && pair.value === 'SECTION') {
      section = pairs[i + 1]?.code === 2 ? pairs[i + 1].value.toUpperCase() : '';
      i++;
      continue;
    }
    if (pair.code === 0 && pair.value === 'ENDSEC') {
      flushEntity();
      section = '';
      continue;
    }
    if (section !== 'ENTITIES') continue;
    if (pair.code === 0) {
      flushEntity();
      current = [pair];
    } else current.push(pair);
  }
  flushEntity();
  return { header: {}, tables: {}, entities, blocks };

  function flushEntity(): void {
    if (!current.length) return;
    const type = current[0]?.value.toUpperCase();
    if (type === 'VERTEX' && polyline) {
      const v = readPoint(current, 10, 20, 30);
      if (v) (polyline.vertices ??= []).push({ ...v, bulge: readNumber(current, 42) });
      current = [];
      return;
    }
    if (type === 'SEQEND') {
      if (polyline) entities.push(polyline);
      polyline = undefined;
      current = [];
      return;
    }
    if (polyline) {
      entities.push(polyline);
      polyline = undefined;
    }
    if (!type || type === 'EOF') { current = []; return; }
    const e = entityFromPairs(type, current);
    if (type === 'POLYLINE') polyline = e;
    else entities.push(e);
    current = [];
  }
}

function entityFromPairs(type: string, pairs: DxfPair[]): CadEntity {
  const common: Record<string, unknown> = {
    type,
    handle: readString(pairs, 5),
    layer: readString(pairs, 8) ?? '0',
    colorIndex: readNumber(pairs, 62),
    trueColor: readNumber(pairs, 420),
    lineType: readString(pairs, 6),
    lineweight: readNumber(pairs, 370)
  };
  switch (type) {
    case 'LINE': Object.assign(common, { startPoint: readPoint(pairs, 10, 20, 30), endPoint: readPoint(pairs, 11, 21, 31) }); break;
    case 'CIRCLE': Object.assign(common, { center: readPoint(pairs, 10, 20, 30), radius: readNumber(pairs, 40) }); break;
    case 'ARC': Object.assign(common, { center: readPoint(pairs, 10, 20, 30), radius: readNumber(pairs, 40), startAngle: degreesToRadiansSafe(readNumber(pairs, 50)), endAngle: degreesToRadiansSafe(readNumber(pairs, 51)) }); break;
    case 'POINT': Object.assign(common, { point: readPoint(pairs, 10, 20, 30) }); break;
    case 'TEXT':
    case 'MTEXT': Object.assign(common, { insertionPoint: readPoint(pairs, 10, 20, 30), text: readJoinedText(pairs), textHeight: readNumber(pairs, 40), rotation: degreesToRadiansSafe(readNumber(pairs, 50)) }); break;
    case 'LWPOLYLINE': Object.assign(common, { vertices: readLwPolylineVertices(pairs), flag: readNumber(pairs, 70), isClosed: (Number(readNumber(pairs, 70) ?? 0) & 1) === 1 }); break;
    case 'POLYLINE': Object.assign(common, { vertices: [], flag: readNumber(pairs, 70), isClosed: (Number(readNumber(pairs, 70) ?? 0) & 1) === 1 }); break;
    case 'ELLIPSE': Object.assign(common, { center: readPoint(pairs, 10, 20, 30), majorAxisEndPoint: readPoint(pairs, 11, 21, 31), axisRatio: readNumber(pairs, 40), startAngle: readNumber(pairs, 41), endAngle: readNumber(pairs, 42) }); break;
    case 'SPLINE': Object.assign(common, { controlPoints: readRepeatedPoints(pairs, 10, 20, 30), degree: readNumber(pairs, 71), isClosed: (Number(readNumber(pairs, 70) ?? 0) & 1) === 1 }); break;
    case 'INSERT': Object.assign(common, { name: readString(pairs, 2), blockName: readString(pairs, 2), insertionPoint: readPoint(pairs, 10, 20, 30), rotation: degreesToRadiansSafe(readNumber(pairs, 50)), scale: { x: readNumber(pairs, 41) ?? 1, y: readNumber(pairs, 42) ?? readNumber(pairs, 41) ?? 1, z: readNumber(pairs, 43) ?? 1 } }); break;
    case 'SOLID':
    case 'TRACE':
    case '3DFACE': Object.assign(common, { vertices: [readPoint(pairs, 10, 20, 30), readPoint(pairs, 11, 21, 31), readPoint(pairs, 12, 22, 32), readPoint(pairs, 13, 23, 33)].filter(Boolean) }); break;
  }
  return normalizeDxfEntity(common);
}

function readNumber(pairs: DxfPair[], code: number): number | undefined {
  const found = pairs.find((pair) => pair.code === code)?.value;
  const n = Number(found);
  return Number.isFinite(n) ? n : undefined;
}
function readString(pairs: DxfPair[], code: number): string | undefined {
  const found = pairs.find((pair) => pair.code === code)?.value;
  return found && found.length > 0 ? found : undefined;
}
function readPoint(pairs: DxfPair[], xCode: number, yCode: number, zCode: number): CadPoint3D | undefined {
  const x = readNumber(pairs, xCode);
  const y = readNumber(pairs, yCode);
  const z = readNumber(pairs, zCode);
  if (x === undefined || y === undefined) return undefined;
  return z === undefined ? { x, y } : { x, y, z };
}
function readRepeatedPoints(pairs: DxfPair[], xCode: number, yCode: number, zCode: number): CadPoint3D[] {
  const out: CadPoint3D[] = [];
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].code !== xCode) continue;
    const x = Number(pairs[i].value);
    const yPair = pairs.slice(i + 1).find((pair) => pair.code === yCode);
    const zPair = pairs.slice(i + 1).find((pair) => pair.code === zCode);
    const y = Number(yPair?.value);
    const z = Number(zPair?.value);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push(Number.isFinite(z) ? { x, y, z } : { x, y });
  }
  return out;
}
function readLwPolylineVertices(pairs: DxfPair[]): Array<CadPoint3D & { bulge?: number }> {
  const out: Array<CadPoint3D & { bulge?: number }> = [];
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].code !== 10) continue;
    const x = Number(pairs[i].value);
    let y: number | undefined;
    let bulge: number | undefined;
    for (let j = i + 1; j < pairs.length; j++) {
      if (pairs[j].code === 10) break;
      if (pairs[j].code === 20) y = Number(pairs[j].value);
      if (pairs[j].code === 42) bulge = Number(pairs[j].value);
    }
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y: y as number, bulge: Number.isFinite(bulge) ? bulge : undefined });
  }
  return out;
}
function readJoinedText(pairs: DxfPair[]): string | undefined {
  const chunks = pairs.filter((pair) => pair.code === 1 || pair.code === 3).map((pair) => pair.value);
  return chunks.length ? chunks.join('') : undefined;
}

function degreesToRadiansSafe(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? degreesToRadians(value) : undefined;
}
