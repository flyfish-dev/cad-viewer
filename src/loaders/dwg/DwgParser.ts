import { addBlock, addLayer, createCadDocument, normalizeCadEntity, numberOrUndefined, pointFromUnknown, stringOrUndefined } from '../../core/entity';
import { exactArrayBuffer } from '../../core/format';
import type { CadBlock, CadDocument, CadEntity, CadLayer, CadLoadOptions, CadLoadProgress, CadLoadResult } from '../../core/types';
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
  const blocks = extractBlocks(record, options);
  const rawEntities = Array.isArray(record.entities) ? record.entities : [];
  const normalizeOptions = { keepRaw: Boolean(options.keepRaw), includeUnknownProperties: Boolean(options.keepRaw) };
  const entities = rawEntities
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => normalizeDwgEntity(item, normalizeOptions));

  const document = createCadDocument({
    format: 'dwg',
    sourceName,
    header: normalizeHeader(record.header, version),
    layers,
    blocks,
    entities,
    metadata: {
      parser: '@mlightcad/libredwg-web',
      parserMode: 'wasm',
      version
    },
    warnings: [],
    raw: options.keepRaw ? rawDb : undefined
  });

  if (entities.length === 0) {
    document.warnings.push('DWG parsed successfully but no model-space entities were exposed by the converter. Check layout/paper-space content or unsupported proxy objects.');
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
