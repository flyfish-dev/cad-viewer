import { createDefaultLoaderRegistry } from '../loaders';
import type { CadLoaderRegistry } from '../loaders/CadLoaderRegistry';
import { summarizeCadDocument } from '../core/entity';
import type { CadDocument, CadLoadInput, CadLoadOptions, CadLoadProgress, CadLoadResult, CadLoader } from '../core/types';
import { CadCanvasRenderer, type CanvasViewerOptions, type RenderStats, type ViewChangeEvent } from './CadCanvasRenderer';
import { CadWebGLRenderer, isWebGLAvailable } from './CadWebGLRenderer';

export type CadViewerRendererBackend = 'auto' | 'webgl' | 'canvas2d';
export type CadRenderer = CadCanvasRenderer | CadWebGLRenderer;

export interface CadViewerOptions extends CadLoadOptions {
  container?: HTMLElement;
  canvas?: HTMLCanvasElement;
  /** Rendering backend. `auto` uses WebGL when available and falls back to Canvas2D. */
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
  private readonly options: Required<Pick<CadViewerOptions, 'autoFit'>> & CadViewerOptions;
  private lastResult?: CadViewerLoadResult;

  constructor(options: CadViewerOptions = {}) {
    this.options = { autoFit: true, ...options };
    this.registry = options.registry ?? createDefaultLoaderRegistry(options);
    if (options.loaders) for (const loader of options.loaders) this.registry.register(loader);

    this.canvas = options.canvas ?? document.createElement('canvas');
    this.canvas.classList.add('cad-viewer-canvas');
    if (!options.canvas && options.container) {
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.canvas.style.display = 'block';
      options.container.appendChild(this.canvas);
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
    try {
      const result = await this.registry.load({ file, fileName: file.name }, this.mergeLoadOptions(options));
      return this.applyLoadResult(result, file.name);
    } catch (error) {
      const normalized = normalizeError(error);
      this.options.onError?.(normalized);
      throw normalized;
    }
  }

  async loadBuffer(buffer: ArrayBuffer | Uint8Array, fileName?: string, options: CadLoadOptions = {}): Promise<CadViewerLoadResult> {
    this.options.onLoadStart?.(buffer);
    try {
      const result = await this.registry.load({ buffer, fileName }, this.mergeLoadOptions(options));
      return this.applyLoadResult(result, fileName);
    } catch (error) {
      const normalized = normalizeError(error);
      this.options.onError?.(normalized);
      throw normalized;
    }
  }

  async load(input: CadLoadInput, options: CadLoadOptions = {}): Promise<CadViewerLoadResult> {
    this.options.onLoadStart?.(input);
    try {
      const result = await this.registry.load(input, this.mergeLoadOptions(options));
      return this.applyLoadResult(result, input.fileName ?? input.file?.name);
    } catch (error) {
      const normalized = normalizeError(error);
      this.options.onError?.(normalized);
      throw normalized;
    }
  }

  setDocument(document: CadDocument, fileName?: string): CadViewerLoadResult {
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

  fit(): void { this.renderer.fitToView(); }
  zoomIn(): void { this.renderer.zoomIn(); }
  zoomOut(): void { this.renderer.zoomOut(); }
  resize(): void { this.renderer.resize(); }
  setCanvasOptions(options: CanvasViewerOptions): void { this.renderer.setOptions(options); }
  async preloadDwg(options: CadLoadOptions = {}): Promise<void> {
    const loader = this.registry.list().find((item) => item.id === 'dwg') as unknown as { preload?: (options?: CadLoadOptions) => Promise<void> } | undefined;
    if (!loader?.preload) throw new Error('The registered DWG loader does not support preload().');
    return loader.preload(this.mergeLoadOptions(options));
  }
  clear(): void { this.lastResult = undefined; this.renderer.clear(); }
  destroy(): void {
    for (const loader of this.registry.list()) {
      const maybeDisposable = loader as unknown as { terminateWorker?: () => void; destroy?: () => void };
      maybeDisposable.terminateWorker?.();
      maybeDisposable.destroy?.();
    }
    this.renderer.destroy();
  }
  getLoadResult(): CadViewerLoadResult | undefined { return this.lastResult; }
  getDocument(): CadDocument | undefined { return this.renderer.getDocument(); }
  getZoomPercent(): number { return this.renderer.getZoomPercent(); }

  private applyLoadResult(result: CadLoadResult, fileName?: string): CadViewerLoadResult {
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
