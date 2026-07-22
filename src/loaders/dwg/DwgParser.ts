import { addBlock, addLayer, addLineType, createCadDocument, normalizeCadDataValue, normalizeCadEntity, numberOrUndefined, pointFromUnknown, stringOrUndefined } from '../../core/entity';
import { exactArrayBuffer } from '../../core/format';
import { multiplyMatrix, rotationMatrix } from '../../core/transform';
import type { CadBlock, CadDataLink, CadDataTable, CadDataTableColumn, CadDataValue, CadDictionary, CadDocument, CadEntity, CadLayer, CadLineType, CadLoadOptions, CadLoadProgress, CadLoadResult, CadPoint3D, CadSavedView, CadSceneTransform2D, CadXRecord } from '../../core/types';
import { readDwgVersion } from './dwgVersion';

interface LibreDwgModule {
  Dwg_File_Type?: Record<string, number>;
  Dwg_Object_Type?: Record<string, number>;
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
  enrichDwgBusinessObjects(rawDb, extractDwgBusinessObjects(lib.instance, dwg, lib.module.Dwg_Object_Type));
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
          return installLibreDwgCompatibilityGuards(LibreDwg.createByWasmInstance(wasmInstance));
        }

        // Important: call the static method on the class object. The upstream
        // implementation uses `this.createByWasmInstance(...)`; extracting
        // `create` into a standalone function loses `this` and causes
        // "Cannot read properties of undefined (reading 'createByWasmInstance')".
        return installLibreDwgCompatibilityGuards(await LibreDwg.create(normalizedPath));
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

/**
 * Keep upstream converter defects isolated at the native-wrapper boundary.
 *
 * libredwg-web 0.7.9 exposes linetype dash records as Embind objects. Some
 * valid DWGs contain a null complex-linetype text pointer; reading the generated
 * `text` property then throws while trying to call `null.toString()`. The
 * converter reads every dash field eagerly, so one empty optional field used to
 * abort the whole drawing. Copying the record through guarded getters preserves
 * all readable fields and treats the invalid optional field as absent.
 */
function installLibreDwgCompatibilityGuards(instance: any): any {
  if (!instance || instance.__cadViewerCompatibilityGuards === true) return instance;
  const original = instance.dwg_ptr_to_ltype_dash_array;
  if (typeof original === 'function') {
    try {
      instance.dwg_ptr_to_ltype_dash_array = (...args: unknown[]) => {
        const dashes = original.apply(instance, args);
        if (!Array.isArray(dashes)) return [];
        return dashes.map((dash) => ({
          length: safeNativeProperty(dash, 'length'),
          complex_shapecode: safeNativeProperty(dash, 'complex_shapecode'),
          shape_flag: safeNativeProperty(dash, 'shape_flag'),
          style: safeNativeReference(instance, safeNativeProperty(dash, 'style')),
          scale: safeNativeProperty(dash, 'scale'),
          rotation: safeNativeProperty(dash, 'rotation'),
          x_offset: safeNativeProperty(dash, 'x_offset'),
          y_offset: safeNativeProperty(dash, 'y_offset'),
          text: safeNativeProperty(dash, 'text')
        }));
      };
    } catch {
      // A frozen third-party wrapper cannot be patched. The original method is
      // left untouched and its converter error will retain the upstream stack.
    }
  }
  try {
    Object.defineProperty(instance, '__cadViewerCompatibilityGuards', { value: true });
  } catch {
    // Non-extensible wrappers are valid; installing the callable guard above is enough.
  }
  return instance;
}

function safeNativeProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeNativeReference(instance: any, reference: unknown): unknown {
  if (!reference) return undefined;
  try {
    return instance.dwg_ref_get_absref?.(reference) == null ? undefined : reference;
  } catch {
    return undefined;
  }
}

export function normalizeDwgDatabase(rawDb: unknown, sourceName?: string, version?: unknown, options: { keepRaw?: boolean } = {}): CadDocument {
  const record = rawDb && typeof rawDb === 'object' ? rawDb as Record<string, unknown> : {};
  const layers = extractLayers(record, options);
  const shapeStyles = extractShxStyles(record);
  const lineTypes = extractLineTypes(record, options, shapeStyles);
  const blocks = extractBlocks(record, options);
  const header = normalizeHeader(record.header, version);
  const requiredShxFonts = extractRequiredShapeFonts(lineTypes);
  const savedViewResult = extractSavedView(record, header);
  const savedView = savedViewResult.view;
  const dictionaries = extractDictionaries(record);
  const xrecords = extractXRecords(record, dictionaries);
  const dataLinks = extractDataLinks(record);
  const dataTables = extractDataTables(record);
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
    dictionaries,
    xrecords,
    dataLinks,
    dataTables,
    metadata: {
      parser: '@mlightcad/libredwg-web',
      parserMode: 'wasm',
      version,
      savedView,
      requiredShxFonts,
      businessData: {
        dictionaries: dictionaries.length,
        xrecords: xrecords.length,
        dataLinks: dataLinks.length,
        dataTables: dataTables.length
      }
    },
    warnings: savedViewResult.warning ? [savedViewResult.warning] : [],
    raw: options.keepRaw ? rawDb : undefined
  });

  if (entities.length === 0) {
    document.warnings.push('DWG parsed successfully but no model-space entities were exposed by the converter. Check layout/paper-space content or unsupported proxy objects.');
  }
  const uniqueLineTypes = new Set(Object.values(lineTypes));
  if ([...uniqueLineTypes].some((lineType) => lineType.pattern.some((element) => Number(element.elementTypeFlag ?? 0) !== 0))) {
    const dependency = requiredShxFonts.length > 0
      ? ` This drawing references external shape font${requiredShxFonts.length === 1 ? '' : 's'} ${requiredShxFonts.join(', ')}, whose outlines are not embedded in the DWG.`
      : '';
    document.warnings.push(`Complex SHX linetype glyphs are preserved in the normalized LTYPE definition and rendered as a dash/dot approximation.${dependency}`);
  }
  return document;
}

interface DwgBusinessObjects {
  DATALINK: Record<string, unknown>[];
  DATATABLE: Record<string, unknown>[];
  TABLECONTENT: Record<string, unknown>[];
  TABLES: Record<string, unknown>[];
}

/**
 * Reads BOM-adjacent objects before LibreDWG native memory is released.
 * The upstream high-level converter currently omits these object classes.
 */
export function extractDwgBusinessObjects(instance: any, dwg: any, objectTypes: Record<string, number> | undefined): DwgBusinessObjects {
  const result: DwgBusinessObjects = { DATALINK: [], DATATABLE: [], TABLECONTENT: [], TABLES: [] };
  if (!instance || !dwg || !objectTypes) return result;
  result.DATALINK = extractNativeObjects(instance, dwg, objectTypes.DWG_TYPE_DATALINK, (item, handle) => {
    const year = numberOrUndefined(readDynamic(instance, item, 'year'));
    const month = numberOrUndefined(readDynamic(instance, item, 'month'));
    const day = numberOrUndefined(readDynamic(instance, item, 'day'));
    const hour = numberOrUndefined(readDynamic(instance, item, 'hour'));
    const minute = numberOrUndefined(readDynamic(instance, item, 'minute'));
    const seconds = numberOrUndefined(readDynamic(instance, item, 'seconds'));
    return compactRecord({
      handle,
      dataAdapter: readDynamic(instance, item, 'data_adapter'),
      description: readDynamic(instance, item, 'description'),
      tooltip: readDynamic(instance, item, 'tooltip'),
      connectionString: readDynamic(instance, item, 'connection_string'),
      option: readDynamic(instance, item, 'option'),
      updateOption: readDynamic(instance, item, 'update_option'),
      pathOption: readDynamic(instance, item, 'path_option'),
      updateStatus: readDynamic(instance, item, 'update_status'),
      lastUpdated: cadDateString(year, month, day, hour, minute, seconds)
    });
  });
  result.DATATABLE = extractNativeObjects(instance, dwg, objectTypes.DWG_TYPE_DATATABLE, (item, handle) => compactRecord({
    handle,
    flags: readDynamic(instance, item, 'flags'),
    rowCount: readDynamic(instance, item, 'num_rows'),
    columnCount: readDynamic(instance, item, 'num_cols'),
    tableName: readDynamic(instance, item, 'table_name'),
    columns: cloneDynamicObject(readDynamic(instance, item, 'cols'))
  }));
  result.TABLECONTENT = extractNativeObjects(instance, dwg, objectTypes.DWG_TYPE_TABLECONTENT, (item, handle) => compactRecord({
    handle,
    linkedData: cloneDynamicObject(readDynamic(instance, item, 'ldata')),
    linkedTableData: cloneDynamicObject(readDynamic(instance, item, 'tdata')),
    formattedTableData: cloneDynamicObject(readDynamic(instance, item, 'fdata')),
    tableStyle: nativeHandleValue(readDynamic(instance, item, 'tablestyle'))
  }));

  const tableType = objectTypes.DWG_TYPE_TABLE;
  if (Number.isFinite(tableType) && typeof instance.dwg_getall_entities_in_model_space === 'function') {
    try {
      for (const object of instance.dwg_getall_entities_in_model_space(dwg) ?? []) {
        if (instance.dwg_object_get_fixedtype?.(object) !== tableType) continue;
        const entity = instance.dwg_object_to_entity?.(object);
        const item = instance.dwg_object_to_entity_tio?.(object);
        if (!entity || !item) continue;
        const handle = nativeHandleValue(instance.dwg_object_entity_get_handle_object?.(entity)?.value);
        result.TABLES.push(compactRecord({
          handle,
          linkedData: cloneDynamicObject(readDynamic(instance, item, 'ldata')),
          linkedTableData: cloneDynamicObject(readDynamic(instance, item, 'tdata')),
          formattedTableData: cloneDynamicObject(readDynamic(instance, item, 'fdata'))
        }));
      }
    } catch {
      // Modern TABLECONTENT is incomplete in some LibreDWG builds. Legacy cells remain available through the converter.
    }
  }
  return result;
}

function enrichDwgBusinessObjects(rawDb: unknown, business: DwgBusinessObjects): void {
  if (!rawDb || typeof rawDb !== 'object') return;
  const database = rawDb as Record<string, unknown>;
  const objects = database.objects && typeof database.objects === 'object'
    ? database.objects as Record<string, unknown>
    : (database.objects = {}) as Record<string, unknown>;
  for (const key of ['DATALINK', 'DATATABLE', 'TABLECONTENT'] as const) {
    if (business[key].length === 0) continue;
    const existing = Array.isArray(objects[key]) ? objects[key] as unknown[] : [];
    objects[key] = mergeHandleRecords(existing, business[key]);
  }
  if (business.TABLES.length > 0 && Array.isArray(database.entities)) {
    const byHandle = new Map(business.TABLES.map((item) => [stringOrUndefined(item.handle)?.toLocaleUpperCase(), item]));
    for (const entity of database.entities) {
      if (!entity || typeof entity !== 'object') continue;
      const record = entity as Record<string, unknown>;
      const enrichment = byHandle.get(stringOrUndefined(record.handle)?.toLocaleUpperCase());
      if (enrichment) Object.assign(record, enrichment);
    }
  }
}

function extractNativeObjects(
  instance: any,
  dwg: any,
  type: number | undefined,
  convert: (item: any, handle?: string) => Record<string, unknown>
): Record<string, unknown>[] {
  if (!Number.isFinite(type) || typeof instance.dwg_getall_object_by_type !== 'function') return [];
  const result: Record<string, unknown>[] = [];
  try {
    for (const item of instance.dwg_getall_object_by_type(dwg, type) ?? []) {
      const object = instance.dwg_obj_generic_to_object?.(item);
      const handle = nativeHandleValue(object ? instance.dwg_object_get_handle_object?.(object)?.value : undefined);
      result.push(convert(item, handle));
    }
  } catch {
    // An unsupported/debugging LibreDWG class must not make an otherwise renderable drawing fail.
  }
  return result;
}

function readDynamic(instance: any, item: any, field: string): unknown {
  try {
    if (typeof instance.dwg_dynapi_entity_data === 'function') return instance.dwg_dynapi_entity_data(item, field);
    return instance.dwg_dynapi_entity_value?.(item, field)?.data;
  } catch {
    return undefined;
  }
}

function cloneDynamicObject(value: unknown): unknown {
  if (!value || typeof value !== 'object' || typeof value === 'number') return undefined;
  return normalizeCadDataValue(value);
}

function nativeHandleValue(value: unknown): string | undefined {
  if (typeof value === 'bigint') return value.toString(16).toLocaleUpperCase();
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value).toString(16).toLocaleUpperCase();
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value)) return nativeHandleValue(value[3] ?? value[2]);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return nativeHandleValue(record.absolute_ref ?? record.absoluteRef ?? record.value ?? record.handle);
  }
  return undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function cadDateString(year?: number, month?: number, day?: number, hour = 0, minute = 0, second = 0): string | undefined {
  if (!year || !month || !day) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function mergeHandleRecords(left: unknown[], right: Record<string, unknown>[]): unknown[] {
  const result = [...left];
  const indexes = new Map<string, number>();
  result.forEach((item, index) => {
    if (item && typeof item === 'object') {
      const handle = nativeHandleValue((item as Record<string, unknown>).handle);
      if (handle) indexes.set(handle.toLocaleUpperCase(), index);
    }
  });
  for (const item of right) {
    const handle = nativeHandleValue(item.handle);
    const index = handle ? indexes.get(handle.toLocaleUpperCase()) : undefined;
    if (index === undefined) result.push(item);
    else result[index] = { ...(result[index] as Record<string, unknown>), ...item };
  }
  return result;
}

function extractDictionaries(rawDb: Record<string, unknown>): CadDictionary[] {
  const objects = rawDb.objects && typeof rawDb.objects === 'object' ? rawDb.objects as Record<string, unknown> : undefined;
  const candidates = [objects?.DICTIONARY, objects?.dictionary, rawDb.dictionaries];
  const result: CadDictionary[] = [];
  const handles = new Set<string>();
  for (const candidate of candidates) {
    for (const item of arrayOrObjectValues(candidate)) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const handle = nativeHandleValue(record.handle ?? record.id);
      if (handle && handles.has(handle.toLocaleUpperCase())) continue;
      const entries: Array<{ name: string; handle: string }> = [];
      if (record.entries && typeof record.entries === 'object' && !Array.isArray(record.entries)) {
        for (const [name, entryHandle] of Object.entries(record.entries as Record<string, unknown>)) {
          const normalized = nativeHandleValue(entryHandle);
          if (name && normalized) entries.push({ name, handle: normalized });
        }
      } else if (Array.isArray(record.texts) && Array.isArray(record.itemhandles)) {
        for (let index = 0; index < Math.min(record.texts.length, record.itemhandles.length); index += 1) {
          const name = stringOrUndefined(record.texts[index]);
          const normalized = nativeHandleValue(record.itemhandles[index]);
          if (name && normalized) entries.push({ name, handle: normalized });
        }
      }
      result.push({ handle, ownerHandle: nativeHandleValue(record.ownerHandle ?? record.owner), entries });
      if (handle) handles.add(handle.toLocaleUpperCase());
    }
  }
  return result;
}

function extractXRecords(rawDb: Record<string, unknown>, dictionaries: CadDictionary[]): CadXRecord[] {
  const objects = rawDb.objects && typeof rawDb.objects === 'object' ? rawDb.objects as Record<string, unknown> : undefined;
  const candidates = [objects?.XRECORD, objects?.xrecords, rawDb.xrecords];
  const result: CadXRecord[] = [];
  const handles = new Set<string>();
  for (const candidate of candidates) {
    for (const item of arrayOrObjectValues(candidate)) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const handle = nativeHandleValue(record.handle ?? record.id);
      if (handle && handles.has(handle.toLocaleUpperCase())) continue;
      const data = (Array.isArray(record.data) ? record.data : Array.isArray(record.entries) ? record.entries : [])
        .flatMap((group): Array<{ code?: number; value: CadDataValue }> => {
          const groupRecord = group && typeof group === 'object' ? group as Record<string, unknown> : undefined;
          const value = normalizeCadDataValue(groupRecord?.value ?? groupRecord?.data ?? group);
          if (value === undefined) return [];
          const code = numberOrUndefined(groupRecord?.code ?? groupRecord?.groupCode);
          return [{ ...(code !== undefined ? { code } : {}), value }];
        });
      const ownerHandle = nativeHandleValue(record.ownerHandle ?? record.owner);
      const location = resolveDictionaryLocation(handle, ownerHandle, dictionaries);
      result.push({
        handle,
        ownerHandle,
        entryName: stringOrUndefined(record.entryName) ?? location.entryName,
        dictionaryPath: Array.isArray(record.dictionaryPath) ? record.dictionaryPath.map(String) : location.path,
        extensionDictionary: nativeHandleValue(record.extensionDictionary),
        cloning: numberOrUndefined(record.cloning),
        data
      });
      if (handle) handles.add(handle.toLocaleUpperCase());
    }
  }
  return result;
}

function resolveDictionaryLocation(handle: string | undefined, ownerHandle: string | undefined, dictionaries: CadDictionary[]): { entryName?: string; path?: string[] } {
  if (!handle) return {};
  const byHandle = new Map(dictionaries.filter((dictionary) => dictionary.handle).map((dictionary) => [dictionary.handle!.toLocaleUpperCase(), dictionary]));
  const owner = ownerHandle ? byHandle.get(ownerHandle.toLocaleUpperCase()) : undefined;
  const entryName = owner?.entries.find((entry) => entry.handle.toLocaleUpperCase() === handle.toLocaleUpperCase())?.name;
  if (!owner) return { entryName };
  const path: string[] = entryName ? [entryName] : [];
  let current = owner;
  const seen = new Set<string>();
  while (current.handle && current.ownerHandle && !seen.has(current.handle.toLocaleUpperCase())) {
    seen.add(current.handle.toLocaleUpperCase());
    const parent = byHandle.get(current.ownerHandle.toLocaleUpperCase());
    if (!parent) break;
    const name = parent.entries.find((entry) => entry.handle.toLocaleUpperCase() === current.handle!.toLocaleUpperCase())?.name;
    if (name) path.unshift(name);
    current = parent;
  }
  return { entryName, path: path.length > 0 ? path : undefined };
}

function extractDataLinks(rawDb: Record<string, unknown>): CadDataLink[] {
  const objects = rawDb.objects && typeof rawDb.objects === 'object' ? rawDb.objects as Record<string, unknown> : undefined;
  const result: CadDataLink[] = [];
  const handles = new Set<string>();
  for (const item of arrayOrObjectValues(objects?.DATALINK ?? objects?.dataLinks ?? rawDb.dataLinks)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const handle = nativeHandleValue(record.handle ?? record.id);
    if (handle && handles.has(handle.toLocaleUpperCase())) continue;
    result.push({
      handle,
      dataAdapter: stringOrUndefined(record.dataAdapter ?? record.data_adapter),
      description: stringOrUndefined(record.description),
      tooltip: stringOrUndefined(record.tooltip),
      connectionString: stringOrUndefined(record.connectionString ?? record.connection_string),
      updateStatus: stringOrUndefined(record.updateStatus ?? record.update_status),
      updateOption: numberOrUndefined(record.updateOption ?? record.update_option),
      pathOption: numberOrUndefined(record.pathOption ?? record.path_option),
      lastUpdated: stringOrUndefined(record.lastUpdated ?? record.last_updated)
    });
    if (handle) handles.add(handle.toLocaleUpperCase());
  }
  return result;
}

function extractDataTables(rawDb: Record<string, unknown>): CadDataTable[] {
  const objects = rawDb.objects && typeof rawDb.objects === 'object' ? rawDb.objects as Record<string, unknown> : undefined;
  const candidates = [objects?.DATATABLE, objects?.dataTables, rawDb.dataTables, objects?.TABLECONTENT];
  const result: CadDataTable[] = [];
  const handles = new Set<string>();
  for (const candidate of candidates) {
    for (const item of arrayOrObjectValues(candidate)) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const handle = nativeHandleValue(record.handle ?? record.id);
      if (handle && handles.has(handle.toLocaleUpperCase())) continue;
      const linkedData = objectRecord(record.linkedData ?? record.ldata);
      const linkedTable = objectRecord(record.linkedTableData ?? record.tdata);
      const columns = normalizeDataTableColumns(record.columns ?? record.cols, linkedTable);
      const rowCount = Math.max(
        0,
        Math.trunc(numberOrUndefined(record.rowCount ?? record.numRows ?? record.num_rows ?? linkedTable?.numRows ?? linkedTable?.num_rows) ?? 0),
        ...columns.map((column) => column.values.length)
      );
      const columnCount = Math.max(
        columns.length,
        Math.trunc(numberOrUndefined(record.columnCount ?? record.numColumns ?? record.numCols ?? record.num_cols ?? linkedTable?.numColumns ?? linkedTable?.numCols ?? linkedTable?.num_cols) ?? 0)
      );
      if (columns.length === 0 && rowCount === 0 && columnCount === 0) continue;
      result.push({
        handle,
        name: stringOrUndefined(record.tableName ?? record.table_name ?? record.name ?? linkedData?.name ?? linkedData?.description),
        rowCount,
        columnCount,
        columns
      });
      if (handle) handles.add(handle.toLocaleUpperCase());
    }
  }
  return result;
}

function normalizeDataTableColumns(value: unknown, linkedTable?: Record<string, unknown>): CadDataTableColumn[] {
  const direct = Array.isArray(value) ? value : Array.isArray(linkedTable?.columns) ? linkedTable!.columns as unknown[] : Array.isArray(linkedTable?.cols) ? linkedTable!.cols as unknown[] : [];
  if (direct.length > 0) {
    return direct.map((column, index) => {
      const record = objectRecord(column);
      const rows = Array.isArray(record?.rows) ? record.rows as unknown[] : Array.isArray(record?.values) ? record.values as unknown[] : [];
      return {
        name: stringOrUndefined(record?.name ?? record?.text) ?? `Column ${index + 1}`,
        type: (stringOrUndefined(record?.type) ?? numberOrUndefined(record?.type)) as string | number | undefined,
        values: rows.map(extractDataTableValue).filter((item): item is NonNullable<typeof item> => item !== undefined)
      };
    });
  }
  const rows = Array.isArray(linkedTable?.rows) ? linkedTable.rows as unknown[] : [];
  const rowCells = rows.map((row) => {
    const record = objectRecord(row);
    return Array.isArray(record?.cells) ? record.cells as unknown[] : [];
  });
  const count = Math.max(0, ...rowCells.map((cells) => cells.length));
  return Array.from({ length: count }, (_, column) => ({
    name: `Column ${column + 1}`,
    values: rowCells.map((cells) => extractDataTableValue(cells[column])).filter((item): item is NonNullable<typeof item> => item !== undefined)
  }));
}

function extractDataTableValue(value: unknown): ReturnType<typeof normalizeCadDataValue> {
  const record = objectRecord(value);
  const contents = Array.isArray(record?.cellContents) ? record.cellContents as unknown[] : Array.isArray(record?.cell_contents) ? record.cell_contents as unknown[] : undefined;
  const source = contents?.[0] ?? record?.value ?? value;
  const typed = objectRecord(source);
  for (const candidate of [typed?.valueString, typed?.value_string, typed?.dataString, typed?.data_string, typed?.dataLong, typed?.data_long, typed?.dataDouble, typed?.data_double, typed?.dataDate, typed?.data_date, typed?.dataPoint, typed?.data_point, typed?.data3dPoint, typed?.data_3dpoint, source]) {
    const normalized = normalizeCadDataValue(candidate);
    if (normalized !== undefined
      && normalized !== null
      && normalized !== ''
      && !(typeof normalized === 'object' && !Array.isArray(normalized) && Object.keys(normalized).length === 0)) return normalized;
  }
  return undefined;
}

function arrayOrObjectValues(value: unknown): unknown[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of ['entries', 'records', 'items', 'values']) if (Array.isArray(record[key])) return record[key] as unknown[];
  return Object.values(record).filter((item) => item && typeof item === 'object');
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function extractRequiredShapeFonts(lineTypes: Record<string, CadLineType>): string[] {
  const referenced = new Set<string>();
  for (const lineType of new Set(Object.values(lineTypes))) {
    for (const element of lineType.pattern) {
      if (Number(element.elementTypeFlag ?? 0) !== 0 && element.fontName) referenced.add(element.fontName);
    }
  }
  return [...referenced].sort((left, right) => left.localeCompare(right));
}

interface DwgShxStyles {
  byReference: Map<string, string>;
  shapeFonts: string[];
}

function extractShxStyles(rawDb: Record<string, unknown>): DwgShxStyles {
  const tables = rawDb.tables as Record<string, unknown> | undefined;
  const candidates = [rawDb.STYLE, rawDb.styles, tables?.STYLE, tables?.styles];
  const byReference = new Map<string, string>();
  const shapeFonts = new Set<string>();
  for (const candidate of candidates) {
    for (const item of expandCandidate(candidate)) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const font = stringOrUndefined(record.font ?? record.fontFileName ?? record.primaryFontFileName);
      if (!font || !/\.shx$/i.test(font)) continue;
      const flag = numberOrUndefined(record.standardFlag ?? record.flag) ?? 0;
      if ((flag & 1) === 1) shapeFonts.add(font);
      for (const reference of [record.handle, record.id, record.name]) {
        const key = styleReferenceKey(reference);
        if (key) byReference.set(key, font);
      }
    }
  }
  return { byReference, shapeFonts: [...shapeFonts] };
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

function extractLineTypes(rawDb: Record<string, unknown>, options: { keepRaw?: boolean }, styles: DwgShxStyles): Record<string, CadLineType> {
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
        const elementTypeFlag = hasLibreDwgPair ? convertedTypeFlag : numberOrUndefined(part.typeFlag ?? part.elementTypeFlag);
        const styleHandle = stringOrUndefined(part.styleObjectId ?? part.styleHandle ?? part.style);
        const fontName = (styleHandle ? styles.byReference.get(styleReferenceKey(styleHandle)) : undefined)
          ?? ((Number(elementTypeFlag ?? 0) & 4) === 4 && styles.shapeFonts.length === 1 ? styles.shapeFonts[0] : undefined);
        return [{
          length,
          elementTypeFlag,
          shapeNumber: hasLibreDwgPair ? convertedShapeCode : numberOrUndefined(part.shapeCode ?? part.shapeNumber),
          scale: numberOrUndefined(part.scale),
          rotation: numberOrUndefined(part.rotation),
          offsetX: numberOrUndefined(part.offsetX),
          offsetY: numberOrUndefined(part.offsetY),
          text: stringOrUndefined(part.text),
          styleHandle,
          fontName
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

function styleReferenceKey(value: unknown): string {
  return String(value ?? '').trim().replace(/^0x/i, '').replace(/^0+(?=[0-9a-f])/i, '').toLowerCase();
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
