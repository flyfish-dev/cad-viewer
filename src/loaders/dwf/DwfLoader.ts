import { DwfViewer, openDwfDocument, type DwfViewerOptions, type LoadedDwfDocument, type LoadOptions as DwfLoadOptions, type PageData, type RenderStats as DwfRenderStats, type W2dPrimitive } from 'dwf-viewer';
import { createCadDocument, flattenPages } from '../../core/entity';
import { detectCadFormat, extensionOf, readInputBytes } from '../../core/format';
import type { CadDocument, CadEntity, CadFormat, CadLoadInput, CadLoadOptions, CadLoadResult, CadNativeRenderableLoader, CadPage, CadPathCommand, CadPoint3D } from '../../core/types';

export class DwfLoader implements CadNativeRenderableLoader {
  readonly id = 'dwf';
  readonly label = 'DWF/DWFx native viewer powered by dwf-viewer';
  readonly formats = ['dwf', 'dwfx', 'xps'] as const;
  readonly nativeRenderer = true as const;
  private readonly defaults: CadLoadOptions;
  private native?: DwfViewer;
  private host?: HTMLElement;
  private lastStats?: DwfRenderStats;

  constructor(defaults: CadLoadOptions = {}) {
    this.defaults = defaults;
  }

  accepts(input: CadLoadInput, bytes?: Uint8Array): boolean {
    const ext = extensionOf(input);
    if (ext === 'dwf' || ext === 'dwfx' || ext === 'xps') return true;
    const format = detectCadFormat(input, bytes);
    return format === 'dwf' || format === 'dwfx' || format === 'xps';
  }

  async load(input: CadLoadInput, options: CadLoadOptions = {}): Promise<CadLoadResult> {
    const merged = { ...this.defaults, ...options };
    const started = performance.now();
    const sourceName = input.fileName ?? input.file?.name;
    const bytes = await readInputBytes(input);
    const format = normalizeFormat(detectCadFormat(input, bytes), extensionOf(input));

    merged.onProgress?.({ phase: 'parse', format, message: 'Opening DWF/DWFx with dwf-viewer…', percent: 48 });
    const loaded = await openDwfDocument(bytes, { fileName: sourceName });
    merged.onProgress?.({ phase: 'normalize', format, message: 'Reading DWF pages, sheets and model metadata…', percent: 76 });

    const document = cadDocumentFromDwf(loaded, sourceName, format, merged.keepRaw === true);
    const elapsedMs = performance.now() - started;
    merged.onProgress?.({ phase: 'done', format: document.format, message: 'DWF/DWFx document ready.', percent: 100, elapsedMs });
    return { document, raw: merged.keepRaw ? loaded : undefined, bytes: bytes.byteLength, elapsedMs, format: document.format, warnings: document.warnings };
  }

  async mount(input: CadLoadInput, host: HTMLElement, options: CadLoadOptions = {}): Promise<CadLoadResult> {
    const merged = { ...this.defaults, ...options };
    const started = performance.now();
    const sourceName = input.fileName ?? input.file?.name;
    const bytes = await readInputBytes(input);
    const format = normalizeFormat(detectCadFormat(input, bytes), extensionOf(input));
    const wasmUrl = resolveDwfWasmUrl(merged);
    const background = resolveDwfBackground(merged);
    const viewerOptions = buildDwfViewerOptions(merged, wasmUrl, background);
    const loadOptions = buildDwfLoadOptions(merged, wasmUrl, background);

    merged.onProgress?.({ phase: 'native-render', format, message: 'Mounting native DWF renderer…', percent: 28 });
    this.unmount();
    this.host = host;
    host.replaceChildren();
    this.native = new DwfViewer(host, viewerOptions);

    merged.onProgress?.({ phase: 'parse', format, message: 'Parsing DWF package and page streams…', percent: 58 });
    await this.native.load(bytes, {
      fileName: sourceName,
      ...loadOptions
    });

    merged.onProgress?.({ phase: 'render', format, message: 'Rendering DWF/DWFx with dwf-viewer…', percent: 88 });
    this.lastStats = await this.native.render();
    const loaded = this.native.getDocument();
    const document = cadDocumentFromDwf(loaded, sourceName, format, merged.keepRaw === true);
    document.metadata.loaderMode = 'Native DWF';
    document.metadata.nativeRenderer = 'dwf-viewer';
    document.metadata.nativeRenderStats = this.lastStats ? { ...this.lastStats, warnings: this.lastStats.warnings.length } : undefined;
    const elapsedMs = performance.now() - started;
    merged.onProgress?.({ phase: 'done', format: document.format, message: 'DWF/DWFx rendered.', percent: 100, elapsedMs });
    return { document, raw: merged.keepRaw ? loaded : undefined, bytes: bytes.byteLength, elapsedMs, format: document.format, warnings: document.warnings };
  }

  unmount(): void {
    this.native?.dispose();
    this.native = undefined;
    this.lastStats = undefined;
    if (this.host) this.host.replaceChildren();
  }

  fit(): void {
    this.native?.fit();
  }

  zoomIn(): void {
    const button = (this.native as unknown as { zoomInButton?: HTMLButtonElement } | undefined)?.zoomInButton;
    button?.click();
  }

  zoomOut(): void {
    const button = (this.native as unknown as { zoomOutButton?: HTMLButtonElement } | undefined)?.zoomOutButton;
    button?.click();
  }

  resize(): void {
    void this.native?.render();
  }

  setNativeOptions(options: CadLoadOptions): void {
    const native = this.native as unknown as {
      background?: string;
      setPreferWebgl?: (value: boolean) => void;
      setPreferWasm?: (value: boolean) => void;
      setLineWeightMode?: (value: NonNullable<CadLoadOptions['dwfLineWeightMode']>) => void;
      minStrokeCssPx?: number;
      maxOverviewStrokeCssPx?: number;
      minTextCssPx?: number;
      minFilledAreaCssPx?: number;
      render?: () => Promise<unknown>;
    } | undefined;
    if (!native) return;
    if (typeof options.dwfBackground === 'string') native.background = options.dwfBackground;
    else {
      const background = resolveDwfBackground(options);
      if (background) native.background = background;
    }
    if (typeof options.dwfPreferWebgl === 'boolean') native.setPreferWebgl?.(options.dwfPreferWebgl);
    if (typeof options.dwfPreferWasm === 'boolean') native.setPreferWasm?.(options.dwfPreferWasm);
    if (options.dwfLineWeightMode) native.setLineWeightMode?.(options.dwfLineWeightMode);
    setOptionalNumber(native, 'minStrokeCssPx', options.dwfMinStrokeCssPx);
    setOptionalNumber(native, 'maxOverviewStrokeCssPx', options.dwfMaxOverviewStrokeCssPx);
    setOptionalNumber(native, 'minTextCssPx', options.dwfMinTextCssPx);
    setOptionalNumber(native, 'minFilledAreaCssPx', options.dwfMinFilledAreaCssPx);
    void native.render?.();
  }

  getLastNativeStats(): DwfRenderStats | undefined {
    return this.lastStats;
  }
}

function cadDocumentFromDwf(loaded: LoadedDwfDocument | undefined, sourceName: string | undefined, format: CadFormat, keepRaw: boolean): CadDocument {
  const warnings = diagnosticsToWarnings(loaded?.diagnostics ?? []);
  const pages = (loaded?.pageData ?? []).map((page, index) => pageToCadPage(page, index));
  for (const page of loaded?.pageData ?? []) warnings.push(...diagnosticsToWarnings(page.diagnostics));
  const metadata = {
    parser: 'dwf-viewer',
    nativeRenderer: 'dwf-viewer',
    dwfKind: loaded?.kind,
    packageEntries: loaded?.packageEntries?.length ?? 0,
    resources: loaded?.resources?.length ?? 0,
    pageKinds: countBy((loaded?.pageData ?? []).map((page) => page.kind)),
    pageNames: (loaded?.pages ?? []).map((page) => page.name)
  };
  return createCadDocument({
    format,
    sourceName,
    layers: {},
    blocks: {},
    pages,
    entities: flattenPages(pages),
    metadata,
    warnings: unique(warnings),
    raw: keepRaw ? loaded : undefined
  });
}

function pageToCadPage(page: PageData, index: number): CadPage {
  const entities = pageEntities(page, index);
  return {
    index,
    name: page.name || page.sourcePath || `${index + 1}`,
    width: page.width || 1000,
    height: page.height || 1000,
    entities
  };
}

function pageEntities(page: PageData, pageIndex: number): CadEntity[] {
  if (page.kind === 'w2d-text') return page.primitives.flatMap((primitive, index) => primitiveToEntity(primitive, pageIndex, index));
  if (page.kind === 'image') {
    return [{ type: 'DWF_IMAGE_PAGE', kind: 'image', pageIndex, width: page.width, height: page.height, imageSource: page.sourcePath }];
  }
  if (page.kind === 'w3d-model') {
    return page.model.meshes.map((mesh, index) => ({
      id: mesh.id,
      type: 'W3D_MESH',
      kind: 'solid',
      pageIndex,
      color: mesh.color ? rgbToHex(mesh.color) : undefined,
      name: mesh.name || `mesh-${index + 1}`,
      raw: { vertexCount: mesh.vertexCount, triangleCount: mesh.triangleCount, materialId: mesh.materialId }
    }));
  }
  if (page.kind === 'xps-fixed-page') {
    return [{ type: 'XPS_FIXED_PAGE', kind: 'viewport', pageIndex, width: page.width, height: page.height, raw: { sourcePath: page.sourcePath } }];
  }
  return [{ type: 'DWF_PAGE', kind: 'viewport', pageIndex, width: page.width, height: page.height, raw: { sourcePath: page.sourcePath } }];
}

function primitiveToEntity(primitive: W2dPrimitive, pageIndex: number, index: number): CadEntity[] {
  const base = {
    id: `dwf-${pageIndex}-${index}`,
    pageIndex,
    color: primitive.stroke,
    fillColor: primitive.fill,
    lineweight: primitive.lineWidth,
    raw: { matrix: primitive.matrix }
  } satisfies Partial<CadEntity>;
  if (primitive.type === 'polyline' || primitive.type === 'polygon') {
    return [{
      ...base,
      type: primitive.type === 'polygon' ? 'DWF_POLYGON' : 'DWF_POLYLINE',
      kind: 'polyline',
      vertices: pointsArrayToCadPoints(primitive.points),
      isClosed: primitive.type === 'polygon'
    }];
  }
  if (primitive.type === 'path') {
    return [{ ...base, type: 'DWF_PATH', kind: 'path', commands: primitive.commands as unknown as CadPathCommand[] }];
  }
  if (primitive.type === 'text') {
    return [{
      ...base,
      type: 'DWF_TEXT',
      kind: 'text',
      insertionPoint: { x: primitive.x, y: primitive.y, z: 0 },
      text: primitive.text,
      textHeight: primitive.size
    }];
  }
  if (primitive.type === 'rect') {
    const x = primitive.x;
    const y = primitive.y;
    const w = primitive.width;
    const h = primitive.height;
    return [{
      ...base,
      type: 'DWF_RECT',
      kind: 'polyline',
      isClosed: true,
      vertices: [
        { x, y, z: 0 },
        { x: x + w, y, z: 0 },
        { x: x + w, y: y + h, z: 0 },
        { x, y: y + h, z: 0 }
      ]
    }];
  }
  return [];
}

function pointsArrayToCadPoints(points: number[]): CadPoint3D[] {
  const out: CadPoint3D[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) out.push({ x: points[i], y: points[i + 1], z: 0 });
  return out;
}

function diagnosticsToWarnings(diagnostics: readonly { level: string; code: string; message: string; source?: string }[]): string[] {
  return diagnostics
    .filter((item) => item.level !== 'info')
    .map((item) => `${item.code}: ${item.message}${item.source ? ` (${item.source})` : ''}`);
}

function normalizeFormat(detected: CadFormat, ext: string): CadFormat {
  if (ext === 'dwf' || ext === 'dwfx' || ext === 'xps') return ext;
  if (detected === 'dwf' || detected === 'dwfx' || detected === 'xps') return detected;
  return 'dwf';
}

function resolveDwfWasmUrl(options: CadLoadOptions): string | undefined {
  if (options.dwfWasmUrl) return options.dwfWasmUrl;
  if (typeof document === 'undefined') return undefined;
  const base = options.wasmPath
    ? new URL(ensureTrailingSlash(options.wasmPath), document.baseURI).href
    : new URL('wasm/', document.baseURI).href;
  return new URL('dwfv-render.wasm', base).href;
}

function resolveDwfBackground(options: CadLoadOptions): string {
  if (options.dwfBackground) return options.dwfBackground;
  const canvasOptions = (options as CadLoadOptions & { canvasOptions?: { background?: string } }).canvasOptions;
  return canvasOptions?.background ?? '#05070d';
}

function buildDwfViewerOptions(options: CadLoadOptions, wasmUrl: string | undefined, background: string): DwfViewerOptions {
  return {
    ...buildDwfLoadOptions(options, wasmUrl, background),
    maxDevicePixelRatio: options.dwfMaxDevicePixelRatio ?? 2,
    maxCanvasPixels: options.dwfMaxCanvasPixels ?? 16_777_216
  };
}

function buildDwfLoadOptions(options: CadLoadOptions, wasmUrl: string | undefined, background: string): DwfLoadOptions {
  return {
    wasmUrl,
    preferWebgl: options.dwfPreferWebgl ?? true,
    preferWasm: options.dwfPreferWasm ?? true,
    background,
    maxGpuCacheBytes: options.dwfMaxGpuCacheBytes ?? 160 * 1024 * 1024,
    maxCachedScenes: options.dwfMaxCachedScenes ?? 2,
    lineWeightMode: options.dwfLineWeightMode ?? 'adaptive',
    minStrokeCssPx: options.dwfMinStrokeCssPx,
    maxOverviewStrokeCssPx: options.dwfMaxOverviewStrokeCssPx,
    minTextCssPx: options.dwfMinTextCssPx,
    minFilledAreaCssPx: options.dwfMinFilledAreaCssPx
  };
}

function setOptionalNumber<T extends object, K extends keyof T>(target: T, key: K, value: number | undefined): void {
  if (typeof value === 'number' && Number.isFinite(value)) target[key] = value as T[K];
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function rgbToHex(rgb: [number, number, number]): string {
  const [r, g, b] = rgb.map((value) => Math.max(0, Math.min(255, Math.round(value * 255))));
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
