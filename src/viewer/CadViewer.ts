import { createDefaultLoaderRegistry } from '../loaders';
import type { CadLoaderRegistry } from '../loaders/CadLoaderRegistry';
import { summarizeCadDocument } from '../core/entity';
import { isCadNativeRenderableLoader, type CadDocument, type CadLoadInput, type CadLoadOptions, type CadLoadProgress, type CadLoadResult, type CadLoader, type CadNativeRenderableLoader } from '../core/types';
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
  onLoadStart?: (source: File | ArrayBuffer | Uint8Array | CadLoadInput) => void;
  onLoadProgress?: (progress: CadLoadProgress) => void;
  onLoad?: (result: CadViewerLoadResult) => void;
  onError?: (error: Error) => void;
  onRenderStats?: (stats: RenderStats) => void;
  onViewChange?: (event: ViewChangeEvent) => void;
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
  private lastResult?: CadViewerLoadResult;
  private activeNativeLoader?: CadNativeRenderableLoader;

  constructor(options: CadViewerOptions = {}) {
    this.options = { autoFit: true, ...options };
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

    this.renderer = createRenderer(options.renderer ?? 'auto', this.canvas, options.canvasOptions);
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

  setDocument(document: CadDocument, fileName?: string): CadViewerLoadResult {
    this.deactivateNativeRenderer();
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
    this.renderer.setDocument(document);
    if (!this.options.autoFit) this.renderer.render();
    this.lastResult = result;
    this.options.onLoad?.(result);
    return result;
  }

  fit(): void {
    if (this.activeNativeLoader) this.activeNativeLoader.fit?.();
    else this.renderer.fitToView();
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

  setCanvasOptions(options: CanvasViewerOptions): void {
    this.options.canvasOptions = { ...(this.options.canvasOptions ?? {}), ...options };
    this.renderer.setOptions(options);
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
  }

  destroy(): void {
    this.deactivateNativeRenderer();
    for (const loader of this.registry.list()) {
      const maybeDisposable = loader as unknown as { terminateWorker?: () => void; destroy?: () => void; unmount?: () => void };
      maybeDisposable.terminateWorker?.();
      maybeDisposable.unmount?.();
      maybeDisposable.destroy?.();
    }
    this.renderer.destroy();
  }

  getLoadResult(): CadViewerLoadResult | undefined { return this.lastResult; }
  getDocument(): CadDocument | undefined { return this.activeNativeLoader ? this.lastResult?.document : this.renderer.getDocument(); }
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
    this.renderer.setDocument(result.document);
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
}

export function createCadViewer(options: CadViewerOptions = {}): CadViewer {
  return new CadViewer(options);
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
