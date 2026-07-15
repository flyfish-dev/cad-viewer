import { addBlock, addLayer, addLineType, createCadDocument, normalizeCadEntity, numberOrUndefined, pointFromUnknown, stringOrUndefined } from '../../core/entity';
import { exactArrayBuffer } from '../../core/format';
import { multiplyMatrix, rotationMatrix } from '../../core/transform';
import type { CadBlock, CadDocument, CadEntity, CadLayer, CadLineType, CadLoadOptions, CadLoadProgress, CadLoadResult, CadPoint3D, CadSavedView, CadSceneTransform2D } from '../../core/types';
import { readDwgVersion } from './dwgVersion';

interface LibreDwgModule {
  Dwg_File_Type?: Record<string, number>;
  LibreDwg?: {
    create(wasmPath?: string): Promise<any>;
    createByWasmInstance?(wasmInstance: any): any;
  };
  createModule?: (moduleArg?: Record<string, unknown>) => Promise<any>;
}

export interface ParseDwgBytesOptions extends CadLoadOptions {
  sourceName?: string;
  onProgress?: (progress: CadLoadProgress) => void;
}

const instances = new Map<string, Promise<any>>();

export async function parseDwgBytes(bytes: Uint8Array, options: ParseDwgBytesOptions = {}): Promise<CadLoadResult> {
  const started = performance.now();
  const sourceName = options.sourceName;
  options.onProgress?.({ phase: 'detect', format: 'dwg', message: 'Validating DWG header…', total: bytes.byteLength });

  const version = readDwgVersion(bytes);
  if (!version.signature.startsWith('AC')) {
    throw new Error(`Invalid DWG header: ${JSON.stringify(version.signature)}.`);
  }

  options.onProgress?.({ phase: 'wasm-init', format: 'dwg', message: 'Initializing LibreDWG WebAssembly…', total: bytes.byteLength });
  const lib = await createLibreDwg(options.wasmPath ?? '/wasm/');

  options.onProgress?.({ phase: 'parse', format: 'dwg', message: `Decoding ${version.signature} DWG…`, total: bytes.byteLength, percent: 35 });
  const fileContent = exactArrayBuffer(bytes);
  const fileType = lib.Dwg_File_Type?.DWG ?? 0;
  const dwg = lib.instance.dwg_read_data(fileContent, fileType);
  if (!dwg) throw new Error('LibreDWG returned an empty DWG result.');
  if (typeof dwg.error === 'number' && dwg.error !== 0) throw new Error(`LibreDWG parse error code: ${dwg.error}.`);

  options.onProgress?.({ phase: 'normalize', format: 'dwg', message: 'Normalizing DWG database…', total: bytes.byteLength, percent: 72 });
  const rawDb = typeof lib.instance.convert === 'function' ? lib.instance.convert(dwg) : dwg;
  try {
    if (typeof lib.instance.dwg_free === 'function') lib.instance.dwg_free(dwg);
  } catch {
    // Different wrapper versions manage native memory differently.
  }

  const document = normalizeDwgDatabase(rawDb, sourceName, version, { keepRaw: Boolean(options.keepRaw) });
  const elapsedMs = performance.now() - started;
  options.onProgress?.({ phase: 'done', format: 'dwg', message: 'DWG loaded.', total: bytes.byteLength, percent: 100, elapsedMs });
  return {
    document,
    raw: options.keepRaw ? rawDb : undefined,
    bytes: bytes.byteLength,
    elapsedMs,
    format: 'dwg',
    warnings: document.warnings
  };
}

export async function createLibreDwg(wasmPath = '/wasm/'): Promise<{ module: LibreDwgModule; instance: any; Dwg_File_Type?: Record<string, number> }> {
  const normalizedPath = normalizeWasmPath(wasmPath);
  let promise = instances.get(normalizedPath);
  if (!promise) {
    promise = import('@mlightcad/libredwg-web').then(async (module) => {
      const typed = module as LibreDwgModule;
      const LibreDwg = typed.LibreDwg;
      if (!LibreDwg || typeof LibreDwg.create !== 'function') {
        throw new Error('@mlightcad/libredwg-web did not expose LibreDwg.create().');
      }

      try {
        // Load the WASM binary explicitly instead of relying on Emscripten's
        // streaming fetch. This makes deployments robust when a CDN returns
        // application/octet-stream, when the server lacks the application/wasm
        // MIME mapping, and, most importantly, lets us detect SPA fallback HTML
        // before the WebAssembly runtime aborts with a cryptic magic-word error.
        if (typeof typed.createModule === 'function' && typeof LibreDwg.createByWasmInstance === 'function') {
          const wasmUrl = getLibreDwgWasmUrl(normalizedPath);
          const wasmBinary = await fetchWasmBinary(wasmUrl);
          const wasmInstance = await typed.createModule({
            wasmBinary,
            locateFile: (filename: string) => new URL(filename, ensureTrailingSlash(normalizedPath)).href
          });
          return LibreDwg.createByWasmInstance(wasmInstance);
        }

        // Important: call the static method on the class object. The upstream
        // implementation uses `this.createByWasmInstance(...)`; extracting
        // `create` into a standalone function loses `this` and causes
        // "Cannot read properties of undefined (reading 'createByWasmInstance')".
        return await LibreDwg.create(normalizedPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to initialize LibreDWG WebAssembly from ${normalizedPath}. Ensure libredwg-web.wasm is deployed at ${getLibreDwgWasmUrl(normalizedPath)} and wasmPath is resolved relative to the page, not the worker script. Run npm run copy:wasm before dev/build. Original error: ${message}`);
      }
    });
    instances.set(normalizedPath, promise);
  }
  const instance = await promise;
  const module = await import('@mlightcad/libredwg-web') as LibreDwgModule;
  return { module, instance, Dwg_File_Type: module.Dwg_File_Type };
}

export function normalizeDwgDatabase(rawDb: unknown, sourceName?: string, version?: unknown, options: { keepRaw?: boolean } = {}): CadDocument {
  const record = rawDb && typeof rawDb === 'object' ? rawDb as Record<string, unknown> : {};
  const layers = extractLayers(record, options);
  const lineTypes = extractLineTypes(record, options);
  const blocks = extractBlocks(record, options);
  const header = normalizeHeader(record.header, version);
  const savedViewResult = extractSavedView(record, header);
  const savedView = savedViewResult.view;
  const rawEntities = Array.isArray(record.entities) ? record.entities : [];
  const normalizeOptions = { keepRaw: Boolean(options.keepRaw), includeUnknownProperties: Boolean(options.keepRaw) };
  const entities = rawEntities
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => normalizeDwgEntity(item, normalizeOptions));

  const document = createCadDocument({
    format: 'dwg',
    sourceName,
    header,
    layers,
    lineTypes,
    blocks,
    entities,
    savedView,
    metadata: {
      parser: '@mlightcad/libredwg-web',
      parserMode: 'wasm',
      version,
      savedView
    },
    warnings: savedViewResult.warning ? [savedViewResult.warning] : [],
    raw: options.keepRaw ? rawDb : undefined
  });

  if (entities.length === 0) {
    document.warnings.push('DWG parsed successfully but no model-space entities were exposed by the converter. Check layout/paper-space content or unsupported proxy objects.');
  }
  const uniqueLineTypes = new Set(Object.values(lineTypes));
  if ([...uniqueLineTypes].some((lineType) => lineType.pattern.some((element) => Number(element.elementTypeFlag ?? 0) !== 0))) {
    document.warnings.push('Complex SHX linetype glyphs are preserved in the normalized LTYPE definition and rendered as a dash/dot approximation; embedded shape glyph fidelity is not available yet.');
  }
  return document;
}


function normalizeDwgEntity(record: Record<string, unknown>, options: { keepRaw?: boolean; includeUnknownProperties?: boolean }): CadEntity {
  const entity = normalizeCadEntity(record, undefined, { ...options, numericColorMode: 'rgb' });
  const rgb = numberOrUndefined(record.color);
  // @mlightcad/libredwg-web exposes DwgEntity.color as a 24-bit RGB value,
  // while DXF parsers commonly expose `color` as an ACI index. DWG normalization
  // must therefore preserve `color` as trueColor even for low RGB values such as
  // 0x0000ff; otherwise valid DWG colors are interpreted as ACI and many files
  // render as a single foreground color.
  if (rgb !== undefined && rgb >= 0 && rgb <= 0xffffff) {
    entity.color = rgb;
    entity.trueColor = rgb;
  }
  entity.colorIndex = numberOrUndefined(record.colorIndex ?? record.colorNumber ?? record.aci) ?? entity.colorIndex;
  entity.colorName = stringOrUndefined(record.colorName ?? record.color_name) ?? entity.colorName;
  const flag = numberOrUndefined(record.flag ?? record.flags);
  if (flag !== undefined) entity.flag = flag;
  const type = String(record.type ?? record.entityType ?? '').toUpperCase();
  const classicPolyline = /^(POLYLINE|POLYLINE_2D|POLYLINE2D|POLYLINE_3D|POLYLINE3D)$/.test(type);
  if (record.isClosed === true || record.closed === true || (classicPolyline && (Number(flag ?? 0) & 1) === 1)
    || (type === 'LWPOLYLINE' && (Number(flag ?? 0) & 0x200) === 0x200)) {
    entity.isClosed = true;
  }
  return entity;
}

function isRenderableAci(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(Math.trunc(value)) >= 1 && Math.abs(Math.trunc(value)) <= 255;
}

function normalizeHeader(header: unknown, version: unknown): Record<string, unknown> {
  const result = header && typeof header === 'object' ? { ...(header as Record<string, unknown>) } : {};
  if (version) result.dwgVersion = version;
  return result;
}

function extractLayers(rawDb: Record<string, unknown>, options: { keepRaw?: boolean }): Record<string, CadLayer> {
  const result: Record<string, CadLayer> = {};
  const candidates: unknown[] = [];
  const tables = rawDb.tables as Record<string, unknown> | undefined;
  for (const key of ['LAYER', 'layer', 'layers']) {
    const value = rawDb[key] ?? tables?.[key];
    if (value) candidates.push(value);
  }
  for (const candidate of candidates) {
    for (const item of expandCandidate(candidate)) {
      const record = item as Record<string, unknown>;
      const name = stringOrUndefined(record.name ?? record.layerName ?? record.entryName);
      if (!name) continue;
      const colorIndex = numberOrUndefined(record.colorIndex ?? record.colorNumber);
      const rawRgb = numberOrUndefined(record.trueColor ?? record.true_color ?? record.truecolor ?? record.colorRGB ?? record.colorRgb ?? record.rgbColor ?? record.rgb);
      const convertedRgb = numberOrUndefined(record.color);
      const useIndexedColor = isRenderableAci(colorIndex);
      const trueColor = rawRgb ?? (!useIndexedColor && convertedRgb !== undefined && convertedRgb >= 0 && convertedRgb <= 0xffffff ? convertedRgb : undefined);
      const layer: CadLayer = {
        name,
        color: useIndexedColor ? undefined : (record.color ?? record.colorName) as CadLayer['color'],
        colorIndex: colorIndex ?? (convertedRgb !== undefined && Math.abs(convertedRgb) <= 257 ? convertedRgb : undefined),
        trueColor,
        lineType: stringOrUndefined(record.lineType ?? record.linetype),
        lineweight: numberOrUndefined(record.lineweight ?? record.lineWeight),
        isVisible: record.isVisible === false || record.off === true || Number(colorIndex ?? record.color ?? 1) < 0 ? false : true,
        isFrozen: Boolean(record.isFrozen ?? record.frozen),
        isLocked: Boolean(record.isLocked ?? record.locked),
        raw: options.keepRaw ? record : undefined
      };
      addLayer(result, layer);
    }
  }
  return result;
}

function extractLineTypes(rawDb: Record<string, unknown>, options: { keepRaw?: boolean }): Record<string, CadLineType> {
  const result: Record<string, CadLineType> = {};
  const tables = rawDb.tables as Record<string, unknown> | undefined;
  const candidates = [rawDb.LTYPE, rawDb.ltype, rawDb.lineTypes, tables?.LTYPE, tables?.ltype, tables?.lineTypes];
  for (const candidate of candidates) {
    for (const item of expandCandidate(candidate)) {
      const record = item as Record<string, unknown>;
      const name = stringOrUndefined(record.name ?? record.lineTypeName ?? record.entryName);
      if (!name) continue;
      const rawPattern = Array.isArray(record.pattern)
        ? record.pattern
        : Array.isArray(record.dashes)
          ? record.dashes
          : [];
      const pattern = rawPattern.flatMap((entry) => {
        if (typeof entry === 'number') return [{ length: entry }];
        if (!entry || typeof entry !== 'object') return [];
        const part = entry as Record<string, unknown>;
        const length = numberOrUndefined(part.elementLength ?? part.length ?? part.dashLength);
        if (length === undefined) return [];
        const convertedShapeCode = numberOrUndefined(part.elementTypeFlag);
        const convertedTypeFlag = numberOrUndefined(part.shapeNumber);
        // @mlightcad/libredwg-web 0.7.x maps LibreDWG's internal names in the
        // opposite direction: complex_shapecode is DXF group 75 (shape number)
        // and shape_flag is group 74 (element type). Restore the public DXF
        // semantics here instead of leaking the converter mismatch downstream.
        const hasLibreDwgPair = convertedShapeCode !== undefined && convertedTypeFlag !== undefined;
        return [{
          length,
          elementTypeFlag: hasLibreDwgPair ? convertedTypeFlag : numberOrUndefined(part.typeFlag ?? part.elementTypeFlag),
          shapeNumber: hasLibreDwgPair ? convertedShapeCode : numberOrUndefined(part.shapeCode ?? part.shapeNumber),
          scale: numberOrUndefined(part.scale),
          rotation: numberOrUndefined(part.rotation),
          offsetX: numberOrUndefined(part.offsetX),
          offsetY: numberOrUndefined(part.offsetY),
          text: stringOrUndefined(part.text)
        }];
      });
      addLineType(result, {
        name,
        handle: stringOrUndefined(record.handle ?? record.id),
        description: stringOrUndefined(record.description),
        totalPatternLength: numberOrUndefined(record.totalPatternLength ?? record.patternLength),
        pattern,
        raw: options.keepRaw ? record : undefined
      });
    }
  }
  return result;
}

function extractSavedView(rawDb: Record<string, unknown>, header: Record<string, unknown>): { view?: CadSavedView; warning?: string } {
  const tables = rawDb.tables as Record<string, unknown> | undefined;
  const vports = expandCandidate(rawDb.VPORT ?? rawDb.vports ?? tables?.VPORT ?? tables?.vports)
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  const active = vports.find((record) => String(record.name ?? '').trim().toLowerCase() === '*active');
  const source = active ? 'vport' as const : 'header-ucs' as const;
  const record = active ?? header;
  const ucsOrigin = pointFromUnknown(record.ucsOrigin ?? record.UCSORG ?? header.UCSORG);
  const ucsXAxis = pointFromUnknown(record.ucsXAxis ?? record.UCSXDIR ?? header.UCSXDIR);
  const ucsYAxis = pointFromUnknown(record.ucsYAxis ?? record.UCSYDIR ?? header.UCSYDIR);
  const twistAngle = numberOrUndefined(record.viewTwistAngle ?? record.twistAngle ?? record.VIEWTWIST) ?? 0;
  const direction = pointFromUnknown(record.viewDirectionFromTarget ?? record.viewDirection ?? record.direction ?? record.VIEWDIR);
  const hasNonWorldUcs = !isWorldUcs(ucsOrigin, ucsXAxis, ucsYAxis);
  const hasViewData = Boolean(active)
    || Boolean(direction)
    || hasNonWorldUcs
    || Math.abs(twistAngle) > 1e-12;
  if (!hasViewData) return {};
  const planView = isPlanViewDirection(direction);
  const sceneTransform = planView
    ? createSavedViewTransform(ucsOrigin, ucsXAxis, ucsYAxis, twistAngle)
    : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const view: CadSavedView = {
    source,
    name: stringOrUndefined(record.name),
    handle: stringOrUndefined(record.handle),
    center: pointFromUnknown(record.center ?? record.VIEWCTR),
    target: pointFromUnknown(record.viewTarget ?? record.target ?? record.TARGET),
    direction,
    viewHeight: numberOrUndefined(record.viewHeight ?? record.height ?? record.VIEWSIZE),
    aspectRatio: numberOrUndefined(record.aspectRatio),
    twistAngle,
    ucsOrigin,
    ucsXAxis,
    ucsYAxis,
    sceneTransformApplied: planView,
    sceneTransform
  };
  return planView
    ? { view }
    : {
        view,
        warning: 'The saved CAD view has a missing, non-finite, or tilted VIEWDIR. File Viewer kept world coordinates instead of applying an unsafe 2D UCS/PLAN rotation.'
      };
}

function createSavedViewTransform(
  origin: CadPoint3D | undefined,
  rawXAxis: CadPoint3D | undefined,
  rawYAxis: CadPoint3D | undefined,
  twistAngle: number
): CadSceneTransform2D {
  const xAxis = normalizePlanAxis(rawXAxis) ?? { x: 1, y: 0 };
  const yAxisCandidate = normalizePlanAxis(rawYAxis) ?? { x: -xAxis.y, y: xAxis.x };
  const projection = xAxis.x * yAxisCandidate.x + xAxis.y * yAxisCandidate.y;
  const orthogonalY = normalizePlanAxis({
    x: yAxisCandidate.x - xAxis.x * projection,
    y: yAxisCandidate.y - xAxis.y * projection
  }) ?? { x: -xAxis.y, y: xAxis.x };
  const base: CadSceneTransform2D = {
    a: xAxis.x,
    b: orthogonalY.x,
    c: xAxis.y,
    d: orthogonalY.y,
    e: origin ? -(origin.x * xAxis.x + origin.y * xAxis.y) : 0,
    f: origin ? -(origin.x * orthogonalY.x + origin.y * orthogonalY.y) : 0
  };
  return multiplyMatrix(rotationMatrix(Number.isFinite(twistAngle) ? twistAngle : 0), base);
}

function normalizePlanAxis(axis: CadPoint3D | undefined): { x: number; y: number } | undefined {
  if (!axis || Math.abs(Number(axis.z ?? 0)) > 1e-6) return undefined;
  const length = Math.hypot(axis.x, axis.y);
  if (!Number.isFinite(length) || length < 1e-12) return undefined;
  return { x: axis.x / length, y: axis.y / length };
}

function isPlanViewDirection(direction: CadPoint3D | undefined): boolean {
  if (!direction || !Number.isFinite(direction.x) || !Number.isFinite(direction.y) || !Number.isFinite(direction.z)) return false;
  const length = Math.hypot(direction.x, direction.y, Number(direction.z));
  if (!Number.isFinite(length) || length < 1e-12) return false;
  return Math.hypot(direction.x, direction.y) / length <= 1e-4
    && Math.abs(Number(direction.z)) / length >= 1 - 1e-8;
}

function isWorldUcs(
  origin: CadPoint3D | undefined,
  xAxis: CadPoint3D | undefined,
  yAxis: CadPoint3D | undefined
): boolean {
  const close = (value: number | undefined, expected: number) => Number.isFinite(value) && Math.abs(Number(value) - expected) <= 1e-10;
  const originWorld = !origin || (close(origin.x, 0) && close(origin.y, 0) && close(origin.z ?? 0, 0));
  const xWorld = !xAxis || (close(xAxis.x, 1) && close(xAxis.y, 0) && close(xAxis.z ?? 0, 0));
  const yWorld = !yAxis || (close(yAxis.x, 0) && close(yAxis.y, 1) && close(yAxis.z ?? 0, 0));
  return originWorld && xWorld && yWorld;
}

function extractBlocks(rawDb: Record<string, unknown>, options: { keepRaw?: boolean }): Record<string, CadBlock> {
  const result: Record<string, CadBlock> = {};
  const candidates: unknown[] = [rawDb.blocks, rawDb.blockHeaders, rawDb.block_records, rawDb.blockRecords];
  const tables = rawDb.tables as Record<string, unknown> | undefined;
  candidates.push(tables?.BLOCK, tables?.BLOCK_RECORD, tables?.blocks);
  const normalizeOptions = { keepRaw: Boolean(options.keepRaw), includeUnknownProperties: Boolean(options.keepRaw) };
  for (const candidate of candidates) {
    for (const item of expandCandidate(candidate)) {
      const record = item as Record<string, unknown>;
      const name = stringOrUndefined(record.name ?? record.blockName ?? record.name2);
      if (!name) continue;
      const rawEntities = Array.isArray(record.entities) ? record.entities : Array.isArray(record.ownedObjects) ? record.ownedObjects : [];
      const entities: CadEntity[] = rawEntities
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
        .map((entry) => normalizeDwgEntity(entry, normalizeOptions));
      addBlock(result, {
        name,
        basePoint: pointFromUnknown(record.basePoint ?? record.origin) ?? { x: 0, y: 0 },
        entities,
        raw: options.keepRaw ? record : undefined
      });
    }
  }
  return result;
}

function expandCandidate(candidate: unknown): unknown[] {
  if (!candidate) return [];
  if (Array.isArray(candidate)) return candidate;
  if (typeof candidate !== 'object') return [];
  const record = candidate as Record<string, unknown>;
  const directValues = Object.values(record).filter((value) => value && typeof value === 'object');
  const arrays = ['entries', 'records', 'items', 'values', 'layers', 'blocks'].flatMap((key) => Array.isArray(record[key]) ? record[key] as unknown[] : []);
  if (arrays.length > 0) return arrays;
  return directValues;
}

function normalizeWasmPath(wasmPath: string): string {
  const trimmed = wasmPath.trim() || '/wasm';
  if (trimmed === '/') return getRuntimeOrigin();
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  if (isAbsoluteUrl(withoutTrailingSlash)) return withoutTrailingSlash;
  if (withoutTrailingSlash.startsWith('/')) return `${getRuntimeOrigin()}${withoutTrailingSlash}`;
  return new URL(withoutTrailingSlash, getRuntimeBaseUrl()).href.replace(/\/+$/, '');
}

function getLibreDwgWasmUrl(wasmPath: string): string {
  return new URL('libredwg-web.wasm', ensureTrailingSlash(wasmPath)).href;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function getRuntimeBaseUrl(): string {
  if (typeof document !== 'undefined' && document.baseURI) return document.baseURI;
  if (typeof location !== 'undefined' && location.href) return location.href;
  return 'http://localhost/';
}

function getRuntimeOrigin(): string {
  if (typeof location !== 'undefined' && location.origin) return location.origin;
  return new URL(getRuntimeBaseUrl()).origin;
}

async function fetchWasmBinary(url: string): Promise<Uint8Array> {
  if (typeof fetch !== 'function') {
    throw new Error('fetch() is not available, so the LibreDWG WASM binary cannot be loaded.');
  }

  const response = await fetch(url, { credentials: 'same-origin', cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`WASM asset request failed with HTTP ${response.status} for ${url}.`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!hasWasmMagic(bytes)) {
    const preview = decodeAsciiPreview(bytes);
    const contentType = response.headers.get('content-type') ?? 'unknown content-type';
    throw new Error(`Invalid WASM asset at ${url}. Expected bytes 00 61 73 6d, got ${formatFirstBytes(bytes)} (${contentType}). The server probably returned an HTML fallback page instead of libredwg-web.wasm. Response preview: ${preview}`);
  }

  return bytes;
}

function hasWasmMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
}

function formatFirstBytes(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, 4)).map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

function decodeAsciiPreview(bytes: Uint8Array): string {
  const text = Array.from(bytes.slice(0, 32))
    .map((byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')
    .join('');
  return JSON.stringify(text);
}
