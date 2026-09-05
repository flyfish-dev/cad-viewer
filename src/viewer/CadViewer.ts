import { createDefaultLoaderRegistry } from '../loaders';
import type { CadLoaderRegistry } from '../loaders/CadLoaderRegistry';
import { summarizeCadDocument } from '../core/entity';
import { extractCadBom } from '../core/bom';
import { createCadRenderDocument, type CadColorMode } from '../core/colorPolicy';
import { CadShxFontRegistry, synchronizeCadDocumentReferences, type CadShxGlyphResolver } from '../core/shx';
import { isCadNativeRenderableLoader, type CadBom, type CadBomOptions, type CadDocument, type CadFitMode, type CadLoadInput, type CadLoadedReference, type CadLoadOptions, type CadLoadProgress, type CadLoadResult, type CadLoader, type CadMissingReference, type CadNativeRenderableLoader, type CadReferenceInput, type CadReferenceState } from '../core/types';
import { CadCanvasRenderer, type CanvasViewerOptions, type RenderStats, type ViewChangeEvent } from './CadCanvasRenderer';
import { CadWebGLRenderer, isWebGLAvailable } from './CadWebGLRenderer';

export type CadViewerRendererBackend = 'auto' | 'webgl' | 'canvas2d';
export type CadRenderer = CadCanvasRenderer | CadWebGLRenderer;

export interface CadViewerOptions extends CadLoadOptions {
  container?: HTMLElement;
  canvas?: HTMLCanvasElement;
  /** Optional DOM host used by native format viewers such as dwf-viewer. */
  nativeHost?: HTMLElement;
  /** Rendering backend for normalized DWG/DXF scenes. `auto` uses WebGL when available and falls back to Canvas2D. */
  renderer?: CadViewerRendererBackend;
  canvasOptions?: CanvasViewerOptions;
  loaders?: CadLoader[];
  registry?: CadLoaderRegistry;
  autoFit?: boolean;
  /** Preserve authored colors or render CAD vectors/text/materials with one fixed color. */
  colorMode?: CadColorMode;
  /** CSS color used by monochrome mode. Defaults to the active renderer foreground. */
  monochromeColor?: string;
  onLoadStart?: (source: File | ArrayBuffer | Uint8Array | CadLoadInput) => void;
  onLoadProgress?: (progress: CadLoadProgress) => void;
  onLoad?: (result: CadViewerLoadResult) => void;
  onError?: (error: Error) => void;
  onRenderStats?: (stats: RenderStats) => void;
  onViewChange?: (event: ViewChangeEvent) => void;
  onReferenceStateChange?: (state: CadReferenceState) => void;
}

export interface CadViewerLoadResult extends CadLoadResult {
  summary: ReturnType<typeof summarizeCadDocument>;
  fileName?: string;
}

export class CadViewer {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: CadRenderer;
  readonly registry: CadLoaderRegistry;
  readonly nativeHost?: HTMLElement;
  private readonly options: Required<Pick<CadViewerOptions, 'autoFit'>> & CadViewerOptions;
  private readonly referenceRegistry = new CadShxFontRegistry();
  private readonly shxGlyphResolver: CadShxGlyphResolver;
  private externalShxGlyphResolver?: CadShxGlyphResolver;
  private lastResult?: CadViewerLoadResult;
  private activeNativeLoader?: CadNativeRenderableLoader;

  constructor(options: CadViewerOptions = {}) {
    this.options = { autoFit: true, colorMode: 'source', ...options };
    this.externalShxGlyphResolver = options.canvasOptions?.shxGlyphResolver;
    this.shxGlyphResolver = {
      resolveShape: (shapeNumber, fontName) => this.referenceRegistry.resolveShape(shapeNumber, fontName)
        ?? this.externalShxGlyphResolver?.resolveShape(shapeNumber, fontName),
      resolveText: (value, fontName) => this.referenceRegistry.resolveText(value, fontName)
        ?? this.externalShxGlyphResolver?.resolveText(value, fontName)
    };
    this.registry = options.registry ?? createDefaultLoaderRegistry(options);
    if (options.loaders) for (const loader of options.loaders) this.registry.register(loader);

    this.canvas = options.canvas ?? document.createElement('canvas');
    this.canvas.classList.add('cad-viewer-canvas');

    if (options.container) {
      options.container.classList.add('cad-viewer-container');
      if (!options.canvas) {
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        options.container.appendChild(this.canvas);
      }
      this.nativeHost = options.nativeHost ?? document.createElement('div');
      this.nativeHost.classList.add('cad-viewer-native-host');
      if (!options.nativeHost) options.container.appendChild(this.nativeHost);
    } else if (options.nativeHost) {
      this.nativeHost = options.nativeHost;
      this.nativeHost.classList.add('cad-viewer-native-host');
    } else if (options.canvas?.parentElement) {
      options.canvas.parentElement.classList.add('cad-viewer-container');
      const host = document.createElement('div');
      host.classList.add('cad-viewer-native-host');
      options.canvas.parentElement.appendChild(host);
      this.nativeHost = host;
    }

    this.renderer = createRenderer(options.renderer ?? 'auto', this.canvas, {
      ...options.canvasOptions,
      shxGlyphResolver: this.shxGlyphResolver
    });
    this.renderer.onStats = (stats) => this.options.onRenderStats?.(stats);
    this.renderer.onViewChange = (event) => this.options.onViewChange?.(event);
  }

  registerLoader(loader: CadLoader): this {
    this.registry.register(loader);
    return this;
  }

  async loadFile(file: File, options: CadLoadOptions = {}): Promise<CadViewerLoadResult> {
    this.options.onLoadStart?.(file);
    return this.loadThroughRegistry({ file, fileName: file.name }, options, file.name);
  }

  async loadBuffer(buffer: ArrayBuffer | Uint8Array, fileName?: string, options: CadLoadOptions = {}): Promise<CadViewerLoadResult> {
    this.options.onLoadStart?.(buffer);
    return this.loadThroughRegistry({ buffer, fileName }, options, fileName);
  }

  async load(input: CadLoadInput, options: CadLoadOptions = {}): Promise<CadViewerLoadResult> {
    this.options.onLoadStart?.(input);
    return this.loadThroughRegistry(input, options, input.fileName ?? input.file?.name);
  }

  async addReference(input: CadReferenceInput): Promise<CadLoadedReference> {
    try {
      const loaded = await this.referenceRegistry.add(input);
      this.refreshCurrentReferences();
      return loaded;
    } catch (error) {
      const normalized = normalizeError(error);
      this.options.onError?.(normalized);
      throw normalized;
    }
  }

  async addReferenceFile(file: File): Promise<CadLoadedReference> {
    return this.addReference({ file, fileName: file.name });
  }

  async addReferenceBuffer(buffer: ArrayBuffer | Uint8Array, fileName: string): Promise<CadLoadedReference> {
    return this.addReference({ buffer, fileName });
  }

  removeReference(fileName: string): boolean {
    const removed = this.referenceRegistry.remove(fileName);
    if (removed) this.refreshCurrentReferences();
    return removed;
  }

  clearReferences(): void {
    this.referenceRegistry.clear();
    this.refreshCurrentReferences();
  }

  getReferenceState(): CadReferenceState {
    return this.referenceRegistry.getState();
  }

  getMissingReferences(): CadMissingReference[] {
    return this.getReferenceState().missing;
  }

  getLoadedReferences(): CadLoadedReference[] {
    return this.getReferenceState().loaded;
  }

  setDocument(document: CadDocument, fileName?: string): CadViewerLoadResult {
    this.deactivateNativeRenderer();
    this.activateDocumentReferences(document);
    const result: CadViewerLoadResult = {
      document,
      raw: document.raw,
      bytes: 0,
      elapsedMs: 0,
      format: document.format,
      warnings: document.warnings,
      summary: summarizeCadDocument(document),
      fileName
    };
    this.renderer.setDocument(this.createRenderDocument(document));
    if (!this.options.autoFit) this.renderer.render();
    this.lastResult = result;
    this.options.onLoad?.(result);
    return result;
  }

  fit(mode?: CadFitMode): void {
    if (this.activeNativeLoader) this.activeNativeLoader.fit?.();
    else this.renderer.fitToView(0.92, mode);
  }

  zoomIn(): void {
    if (this.activeNativeLoader) this.activeNativeLoader.zoomIn?.();
    else this.renderer.zoomIn();
  }

  zoomOut(): void {
    if (this.activeNativeLoader) this.activeNativeLoader.zoomOut?.();
    else this.renderer.zoomOut();
  }

  resize(): void {
    if (this.activeNativeLoader) this.activeNativeLoader.resize?.();
    else this.renderer.resize();
  }

  /**
   * Switches the active viewer between authored colors and a fixed plot color.
   * The parsed document is never rewritten. Existing pan/zoom state is retained.
   */
  setColorMode(mode: CadColorMode, monochromeColor = this.options.monochromeColor): void {
    const nextMode: CadColorMode = mode === 'monochrome' ? 'monochrome' : 'source';
    const nextColor = normalizeOptionalColor(monochromeColor);
    if (nextMode === this.getColorMode() && nextColor === this.getMonochromeColor()) return;
    this.options.colorMode = nextMode;
    this.options.monochromeColor = nextColor;
    this.refreshColorPolicy();
  }

  getColorMode(): CadColorMode {
    return this.options.colorMode === 'monochrome' ? 'monochrome' : 'source';
  }

  getMonochromeColor(): string | undefined {
    return normalizeOptionalColor(this.options.monochromeColor);
  }

  setCanvasOptions(options: CanvasViewerOptions): void {
    this.options.canvasOptions = { ...(this.options.canvasOptions ?? {}), ...options };
    if (options.shxGlyphResolver) this.externalShxGlyphResolver = options.shxGlyphResolver;
    this.renderer.setOptions({ ...options, shxGlyphResolver: this.shxGlyphResolver });
    if (this.activeNativeLoader) {
      this.activeNativeLoader.setNativeOptions?.({
        ...this.mergeLoadOptions({}),
        dwfBackground: options.background ?? this.options.dwfBackground
      });
    }
  }

  async preloadDwg(options: CadLoadOptions = {}): Promise<void> {
    const loader = this.registry.list().find((item) => item.id === 'dwg') as unknown as { preload?: (options?: CadLoadOptions) => Promise<void> } | undefined;
    if (!loader?.preload) throw new Error('The registered DWG loader does not support preload().');
    return loader.preload(this.mergeLoadOptions(options));
  }

  clear(): void {
    this.lastResult = undefined;
    this.deactivateNativeRenderer();
    this.renderer.clear();
    this.referenceRegistry.setDocument(undefined);
    this.emitReferenceState();
  }

  destroy(): void {
    this.deactivateNativeRenderer();
    for (const loader of this.registry.list()) {
      const maybeDisposable = loader as unknown as { terminateWorker?: () => void; destroy?: () => void; unmount?: () => void };
      maybeDisposable.terminateWorker?.();
      maybeDisposable.unmount?.();
      maybeDisposable.destroy?.();
    }
    this.referenceRegistry.clear();
    this.renderer.destroy();
  }

  getLoadResult(): CadViewerLoadResult | undefined { return this.lastResult; }
  getDocument(): CadDocument | undefined { return this.activeNativeLoader ? this.lastResult?.document : this.renderer.getDocument(); }
  getSourceDocument(): CadDocument | undefined { return this.lastResult?.document; }
  /** Returns a fresh BOM derived from the parser-owned WCS document, or undefined before a file is loaded. */
  getBom(options: CadBomOptions = {}): CadBom | undefined {
    const document = this.getSourceDocument();
    return document ? extractCadBom(document, options) : undefined;
  }
  getZoomPercent(): number { return this.activeNativeLoader ? 100 : this.renderer.getZoomPercent(); }
  isNativeRendererActive(): boolean { return Boolean(this.activeNativeLoader); }

  private async loadThroughRegistry(input: CadLoadInput, options: CadLoadOptions, fileName?: string): Promise<CadViewerLoadResult> {
    try {
      const merged = this.mergeLoadOptions(options);
      throwIfAborted(merged.signal);
      const detected = await this.registry.detect(input);
      const normalizedInput: CadLoadInput = { ...input, buffer: detected.bytes };
      if (isCadNativeRenderableLoader(detected.loader)) {
        return await this.applyNativeLoadResult(detected.loader, normalizedInput, merged, fileName);
      }
      const result = await detected.loader.load(normalizedInput, merged);
      return this.applyLoadResult(result, fileName);
    } catch (error) {
      const normalized = normalizeError(error);
      this.options.onError?.(normalized);
      throw normalized;
    }
  }

  private applyLoadResult(result: CadLoadResult, fileName?: string): CadViewerLoadResult {
    this.deactivateNativeRenderer();
    this.options.onLoadProgress?.({ phase: 'render', format: result.format, message: 'Rendering normalized CAD scene…', percent: 96 });
    this.activateDocumentReferences(result.document);
    result.warnings = result.document.warnings;
    this.renderer.setDocument(this.createRenderDocument(result.document));
    if (!this.options.autoFit) this.renderer.render();
    const value: CadViewerLoadResult = {
      ...result,
      fileName,
      summary: summarizeCadDocument(result.document)
    };
    this.lastResult = value;
    this.options.onLoad?.(value);
    return value;
  }

  private async applyNativeLoadResult(loader: CadNativeRenderableLoader, input: CadLoadInput, options: CadLoadOptions, fileName?: string): Promise<CadViewerLoadResult> {
    if (!this.nativeHost) {
      throw new Error('Native DWF rendering requires CadViewerOptions.container, nativeHost, or a canvas parent element.');
    }
    throwIfAborted(options.signal);
    this.renderer.clear();
    this.activeNativeLoader?.unmount();
    this.activeNativeLoader = loader;
    this.canvas.style.display = 'none';
    this.nativeHost.classList.add('is-active');

    try {
      const result = await loader.mount(input, this.nativeHost, options);
      throwIfAborted(options.signal);
      this.activateDocumentReferences(result.document);
      result.warnings = result.document.warnings;
      const value: CadViewerLoadResult = {
        ...result,
        fileName,
        summary: summarizeCadDocument(result.document)
      };
      this.lastResult = value;
      this.emitNativeRenderStats(result);
      this.options.onLoad?.(value);
      return value;
    } catch (error) {
      this.deactivateNativeRenderer();
      throw error;
    }
  }

  private deactivateNativeRenderer(): void {
    if (!this.activeNativeLoader && !this.nativeHost?.classList.contains('is-active')) {
      this.canvas.style.display = '';
      return;
    }
    this.activeNativeLoader?.unmount();
    this.activeNativeLoader = undefined;
    if (this.nativeHost) {
      this.nativeHost.classList.remove('is-active');
      this.nativeHost.replaceChildren();
    }
    this.canvas.style.display = '';
  }

  private emitNativeRenderStats(result: CadLoadResult): void {
    const metadata = result.document.metadata as { nativeRenderStats?: { backend?: string; commands?: number } };
    const commands = Number(metadata.nativeRenderStats?.commands ?? result.document.entities.length ?? 0);
    const backendText = String(metadata.nativeRenderStats?.backend ?? 'webgl');
    const backend: RenderStats['backend'] = backendText.includes('webgl') ? 'webgl' : 'canvas2d';
    this.options.onRenderStats?.({
      total: commands,
      drawn: commands,
      skipped: 0,
      byType: summarizeCadDocument(result.document).byType,
      unsupported: {},
      renderElapsedMs: result.elapsedMs,
      backend,
      primitiveCount: commands,
      visiblePrimitiveCount: commands,
      culledPrimitiveCount: 0,
      gpuMemoryBytes: undefined,
      buildElapsedMs: result.elapsedMs
    });
  }

  private mergeLoadOptions(options: CadLoadOptions): CadLoadOptions {
    const baseProgress = this.options.onProgress;
    const overrideProgress = options.onProgress;
    return {
      ...this.options,
      ...options,
      onProgress: (progress) => {
        this.options.onLoadProgress?.(progress);
        baseProgress?.(progress);
        if (overrideProgress && overrideProgress !== baseProgress) overrideProgress(progress);
      }
    };
  }

  private createRenderDocument(document: CadDocument): CadDocument {
    return createCadRenderDocument(document, {
      mode: this.getColorMode(),
      monochromeColor: this.getMonochromeColor()
    });
  }

  private refreshColorPolicy(): void {
    if (this.activeNativeLoader) {
      this.activeNativeLoader.setNativeOptions?.(this.mergeLoadOptions({}));
      return;
    }
    const document = this.lastResult?.document;
    if (!document) return;
    const view = this.renderer.getViewState();
    this.renderer.setDocument(this.createRenderDocument(document));
    this.renderer.setViewState(view);
  }

  private activateDocumentReferences(document: CadDocument): void {
    this.referenceRegistry.setDocument(document);
    synchronizeCadDocumentReferences(document, this.referenceRegistry.getState());
    this.emitReferenceState();
  }

  private refreshCurrentReferences(): void {
    const document = this.lastResult?.document;
    if (document) {
      this.referenceRegistry.setDocument(document);
      synchronizeCadDocumentReferences(document, this.referenceRegistry.getState());
      this.lastResult!.warnings = document.warnings;
      this.lastResult!.summary = summarizeCadDocument(document);
      if (!this.activeNativeLoader) this.renderer.refreshReferences();
    }
    this.emitReferenceState();
  }

  private emitReferenceState(): void {
    this.options.onReferenceStateChange?.(this.referenceRegistry.getState());
  }
}

export function createCadViewer(options: CadViewerOptions = {}): CadViewer {
  return new CadViewer(options);
}

function normalizeOptionalColor(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new DOMException('Loading cancelled.', 'AbortError');
}

function createRenderer(backend: CadViewerRendererBackend, canvas: HTMLCanvasElement, options: CanvasViewerOptions = {}): CadRenderer {
  if (backend === 'canvas2d') return new CadCanvasRenderer(canvas, options);
  if (backend === 'webgl') return new CadWebGLRenderer(canvas, options);
  if (isWebGLAvailable()) {
    try {
      return new CadWebGLRenderer(canvas, options);
    } catch {
      // Fall through to Canvas2D. Some browsers report WebGL support but reject the actual context.
    }
  }
  return new CadCanvasRenderer(canvas, options);
}
