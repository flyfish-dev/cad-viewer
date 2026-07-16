import { applyByBlockColorInheritance, layerVisible, resolveCadColor, resolveFillColor } from '../core/color';
import { computeCadDocumentBounds, resolveCadFitBounds } from '../core/bounds';
import { arcPoints, boundsValid, bulgeToPolylinePoints, clamp, ellipsePoints, emptyBounds, includePoint, isFinitePoint, stripMTextFormatting, xy } from '../core/geometry';
import { cadEntityWorldStrokeWidth, inferEntityKind, isCadPolylineClosed } from '../core/entity';
import { applyByBlockLineTypeInheritance, createDashedCadPrimitives, resolveCadLinePattern, transformCadLineTypeGlyph, type CadLineTypeMarker } from '../core/linetype';
import { createCadSceneDocument } from '../core/scene';
import { EMPTY_SHX_GLYPH_RESOLVER, type CadShxGlyph } from '../core/shx';
import { matrixFromInsert, transformEntity } from '../core/transform';
import type { CadBlock, CadBounds, CadDocument, CadEntity, CadFitMode, CadPathCommand, CadPoint2D, CadPoint3D } from '../core/types';
import type { CanvasViewerOptions, RenderStats, ViewChangeEvent, ViewState } from './CadCanvasRenderer';

type GL = WebGLRenderingContext | WebGL2RenderingContext;
type GlMode = WebGLRenderingContext['LINES'] | WebGLRenderingContext['TRIANGLES'] | WebGLRenderingContext['POINTS'];

type RgbaBytes = [number, number, number, number];

interface CpuBatch {
  positions: Float32Array;
  colors: Uint8Array;
  bounds: CadBounds;
  primitiveCount: number;
}

interface GpuBatch {
  positionBuffer: WebGLBuffer;
  colorBuffer: WebGLBuffer;
  vertexCount: number;
  primitiveCount: number;
  bounds: CadBounds;
  gpuBytes: number;
}

interface TextItem {
  point: CadPoint2D;
  text: string;
  height: number;
  rotation: number;
  xScale: number;
  generationFlag: number;
  halign: number;
  valign: number;
  color: string;
  opacity: number;
  bounds: CadBounds;
}

interface ImageItem {
  point: CadPoint2D;
  width: number;
  height: number;
  source?: string;
  color: string;
  opacity: number;
  bounds: CadBounds;
}

interface CpuScene {
  origin: CadPoint2D;
  lineBatches: CpuBatch[];
  triangleBatches: CpuBatch[];
  lineTypePointBatches: CpuBatch[];
  pointBatches: CpuBatch[];
  textItems: TextItem[];
  imageItems: ImageItem[];
  stats: Omit<RenderStats, 'renderElapsedMs'>;
  primitiveCount: number;
  buildElapsedMs: number;
}

interface GpuScene {
  origin: CadPoint2D;
  lineBatches: GpuBatch[];
  triangleBatches: GpuBatch[];
  lineTypePointBatches: GpuBatch[];
  pointBatches: GpuBatch[];
  textItems: TextItem[];
  imageItems: ImageItem[];
  stats: Omit<RenderStats, 'renderElapsedMs'>;
  primitiveCount: number;
  gpuMemoryBytes: number;
  buildElapsedMs: number;
}

interface ProgramInfo {
  program: WebGLProgram;
  aPosition: number;
  aColor: number;
  uViewCenter: WebGLUniformLocation;
  uScale: WebGLUniformLocation;
  uViewport: WebGLUniformLocation;
  uPointSize: WebGLUniformLocation;
}

const DEFAULT_WEBGL_OPTIONS: Required<CanvasViewerOptions> = {
  background: '#0b1020',
  foreground: '#ffffff',
  showUnsupportedMarkers: false,
  showImagePlaceholders: true,
  showPageBounds: true,
  minScale: 1e-9,
  maxScale: 1e9,
  wheelZoomFactor: 1.14,
  trueColorByteOrder: 'rgb',
  maxInsertDepth: 16,
  fitMode: 'auto',
  contrastMode: 'adaptive',
  minColorContrast: 2.4,
  maxCurveSegments: 96,
  spatialIndexCellCount: 72,
  maxVerticesPerBatch: 65536,
  textMinPixelHeight: 4,
  maxVisibleTextLabels: 2500,
  powerPreference: 'high-performance',
  antialias: true,
  preserveDrawingBuffer: false,
  enableSpatialIndex: true,
  shxGlyphResolver: EMPTY_SHX_GLYPH_RESOLVER
};

export class CadWebGLRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly backend = 'webgl' as const;
  private readonly gl: GL;
  private readonly program: ProgramInfo;
  private readonly eventController = new AbortController();
  private readonly imageCache = new Map<string, HTMLImageElement>();
  private opts: Required<CanvasViewerOptions>;
  private sourceDocument?: CadDocument;
  private document?: CadDocument;
  private bounds: CadBounds = emptyBounds();
  private view: ViewState = { centerX: 0, centerY: 0, scale: 1 };
  private fitScale = 1;
  private dpr = 1;
  private isDragging = false;
  private lastPointer?: { x: number; y: number };
  private resizeObserver?: ResizeObserver;
  private overlayCanvas?: HTMLCanvasElement;
  private overlayCtx?: CanvasRenderingContext2D;
  private scene?: GpuScene;
  private stats: RenderStats = { total: 0, drawn: 0, skipped: 0, byType: {}, unsupported: {}, renderElapsedMs: 0, backend: 'webgl', primitiveCount: 0, visiblePrimitiveCount: 0, culledPrimitiveCount: 0, gpuMemoryBytes: 0, buildElapsedMs: 0 };
  private rafHandle = 0;

  onStats?: (stats: RenderStats) => void;
  onViewChange?: (event: ViewChangeEvent) => void;

  constructor(canvas: HTMLCanvasElement, options: CanvasViewerOptions = {}) {
    const gl = createWebGLContext(canvas, options);
    if (!gl) throw new Error('WebGL is not available. Use renderer: "canvas2d" to force the Canvas2D fallback.');
    this.canvas = canvas;
    this.gl = gl;
    this.program = createProgramInfo(gl);
    this.opts = { ...DEFAULT_WEBGL_OPTIONS, ...options };
    this.canvas.classList.add('cad-viewer-canvas', 'cad-viewer-webgl-canvas');
    this.createOverlayCanvas();
    this.bindEvents();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    this.resize();
  }

  static isSupported(): boolean {
    return isWebGLAvailable();
  }

  destroy(): void {
    this.eventController.abort();
    this.resizeObserver?.disconnect();
    this.cancelScheduledRender();
    this.disposeScene();
    this.overlayCanvas?.remove();
  }

  clear(): void {
    this.sourceDocument = undefined;
    this.document = undefined;
    this.bounds = emptyBounds();
    this.view = { centerX: 0, centerY: 0, scale: 1 };
    this.fitScale = 1;
    this.disposeScene();
    this.render();
    this.emitViewChange();
  }

  setDocument(document: CadDocument): void {
    this.sourceDocument = document;
    this.document = createCadSceneDocument(document);
    this.bounds = computeCadDocumentBounds(this.document, this.boundsOptions());
    this.disposeScene();
    const cpuScene = buildCpuScene(this.document, this.opts, this.bounds);
    this.scene = uploadScene(this.gl, cpuScene);
    this.stats = createStatsFromScene(this.scene, 0);
    this.fitToView();
  }

  refreshReferences(): void {
    if (!this.document) return;
    const view = { ...this.view };
    const fitScale = this.fitScale;
    this.disposeScene();
    const cpuScene = buildCpuScene(this.document, this.opts, this.bounds);
    this.scene = uploadScene(this.gl, cpuScene);
    this.stats = createStatsFromScene(this.scene, 0);
    this.view = view;
    this.fitScale = fitScale;
    this.render();
    this.emitViewChange();
  }

  getDocument(): CadDocument | undefined {
    return this.document;
  }

  getSourceDocument(): CadDocument | undefined { return this.sourceDocument; }

  setOptions(options: CanvasViewerOptions): void {
    const rebuildRequired = requiresSceneRebuild(this.opts, options);
    const refit = options.fitMode !== undefined && options.fitMode !== this.opts.fitMode;
    this.opts = { ...this.opts, ...options };
    if (rebuildRequired && (this.sourceDocument ?? this.document)) {
      this.setDocument(this.sourceDocument ?? this.document!);
      return;
    }
    if (refit && this.document) {
      this.fitToView();
      return;
    }
    this.render();
    this.emitViewChange();
  }

  getOptions(): Required<CanvasViewerOptions> {
    return { ...this.opts };
  }

  fitToView(padding = 0.92, mode: CadFitMode = this.opts.fitMode): void {
    const fitBounds = this.document
      ? resolveCadFitBounds(this.document, this.bounds, mode, this.boundsOptions())
      : this.bounds;
    if (!boundsValid(fitBounds)) {
      this.view = { centerX: 0, centerY: 0, scale: 1 };
      this.fitScale = 1;
      this.render();
      this.emitViewChange();
      return;
    }
    const w = Math.max(1, this.cssWidth);
    const h = Math.max(1, this.cssHeight);
    const bw = Math.max(fitBounds.maxX - fitBounds.minX, 1e-9);
    const bh = Math.max(fitBounds.maxY - fitBounds.minY, 1e-9);
    const scale = this.clampScale(Math.min(w / bw, h / bh) * padding);
    this.fitScale = scale;
    this.view = {
      centerX: (fitBounds.minX + fitBounds.maxX) / 2,
      centerY: (fitBounds.minY + fitBounds.maxY) / 2,
      scale
    };
    this.render();
    this.emitViewChange();
  }

  resize(): void {
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(this.cssWidth * this.dpr));
    const h = Math.max(1, Math.floor(this.cssHeight * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.resizeOverlay(w, h);
    this.render();
    this.emitViewChange();
  }

  zoom(factor: number, anchor?: CadPoint2D): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const point = anchor ?? { x: this.cssWidth / 2, y: this.cssHeight / 2 };
    const before = this.screenToWorld(point);
    this.view.scale = this.clampScale(this.view.scale * factor);
    const after = this.screenToWorld(point);
    this.view.centerX += before.x - after.x;
    this.view.centerY += before.y - after.y;
    this.scheduleRender();
    this.emitViewChange();
  }

  zoomIn(): void { this.zoom(this.opts.wheelZoomFactor); }
  zoomOut(): void { this.zoom(1 / this.opts.wheelZoomFactor); }

  panByScreenDelta(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.view.centerX -= dx / this.view.scale;
    this.view.centerY += dy / this.view.scale;
    this.scheduleRender();
    this.emitViewChange();
  }

  setViewState(view: ViewState): void {
    if (![view.centerX, view.centerY, view.scale].every(Number.isFinite)) throw new Error('Invalid view state.');
    this.view = { ...view, scale: this.clampScale(view.scale) };
    this.render();
    this.emitViewChange();
  }

  getViewState(): ViewState { return { ...this.view }; }
  getBounds(): CadBounds { return { ...this.bounds }; }
  getStats(): RenderStats { return cloneStats(this.stats); }
  getZoomRatio(): number { return Math.abs(this.fitScale) < 1e-12 ? 1 : this.view.scale / this.fitScale; }
  getZoomPercent(): number { return this.getZoomRatio() * 100; }

  worldToScreen(p: CadPoint2D): CadPoint2D {
    return {
      x: this.cssWidth / 2 + (p.x - this.view.centerX) * this.view.scale,
      y: this.cssHeight / 2 - (p.y - this.view.centerY) * this.view.scale
    };
  }

  screenToWorld(p: CadPoint2D): CadPoint2D {
    return {
      x: this.view.centerX + (p.x - this.cssWidth / 2) / this.view.scale,
      y: this.view.centerY - (p.y - this.cssHeight / 2) / this.view.scale
    };
  }

  render(): RenderStats {
    this.cancelScheduledRender();
    return this.renderNow();
  }

  private renderNow(): RenderStats {
    const started = performance.now();
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const bg = cssToRgbaBytes(this.opts.background, [11, 16, 32, 255]);
    gl.clearColor(bg[0] / 255, bg[1] / 255, bg[2] / 255, bg[3] / 255);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let visiblePrimitiveCount = 0;
    let culledPrimitiveCount = 0;
    const scene = this.scene;
    const visibleBounds = this.visibleWorldBounds();
    if (scene) {
      gl.useProgram(this.program.program);
      gl.uniform2f(this.program.uViewCenter, this.view.centerX - scene.origin.x, this.view.centerY - scene.origin.y);
      gl.uniform1f(this.program.uScale, this.view.scale * this.dpr);
      gl.uniform2f(this.program.uViewport, this.canvas.width, this.canvas.height);
      gl.uniform1f(this.program.uPointSize, Math.max(1, this.dpr));
      const lineCounts = this.drawBatches(scene.lineBatches, gl.LINES, visibleBounds);
      visiblePrimitiveCount += lineCounts.visible;
      culledPrimitiveCount += lineCounts.culled;
      const triangleCounts = this.drawBatches(scene.triangleBatches, gl.TRIANGLES, visibleBounds);
      visiblePrimitiveCount += triangleCounts.visible;
      culledPrimitiveCount += triangleCounts.culled;
      const lineTypePointCounts = this.drawBatches(scene.lineTypePointBatches, gl.POINTS, visibleBounds);
      visiblePrimitiveCount += lineTypePointCounts.visible;
      culledPrimitiveCount += lineTypePointCounts.culled;
      gl.uniform1f(this.program.uPointSize, Math.max(2, Math.min(12, 4 * this.dpr)));
      const pointCounts = this.drawBatches(scene.pointBatches, gl.POINTS, visibleBounds);
      visiblePrimitiveCount += pointCounts.visible;
      culledPrimitiveCount += pointCounts.culled;
    }

    this.renderOverlay(visibleBounds);
    const renderElapsedMs = performance.now() - started;
    this.stats = scene
      ? { ...scene.stats, renderElapsedMs, backend: 'webgl', primitiveCount: scene.primitiveCount, visiblePrimitiveCount, culledPrimitiveCount, gpuMemoryBytes: scene.gpuMemoryBytes, buildElapsedMs: scene.buildElapsedMs }
      : { total: 0, drawn: 0, skipped: 0, byType: {}, unsupported: {}, renderElapsedMs, backend: 'webgl', primitiveCount: 0, visiblePrimitiveCount: 0, culledPrimitiveCount: 0, gpuMemoryBytes: 0, buildElapsedMs: 0 };
    this.onStats?.(this.getStats());
    return this.getStats();
  }

  private drawBatches(batches: GpuBatch[], mode: GlMode, visibleBounds: CadBounds): { visible: number; culled: number } {
    const gl = this.gl;
    let visible = 0;
    let culled = 0;
    for (const batch of batches) {
      if (!boundsIntersects(batch.bounds, visibleBounds)) {
        culled += batch.primitiveCount;
        continue;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.positionBuffer);
      gl.enableVertexAttribArray(this.program.aPosition);
      gl.vertexAttribPointer(this.program.aPosition, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.colorBuffer);
      gl.enableVertexAttribArray(this.program.aColor);
      gl.vertexAttribPointer(this.program.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.drawArrays(mode, 0, batch.vertexCount);
      visible += batch.primitiveCount;
    }
    return { visible, culled };
  }

  private scheduleRender(): void {
    if (this.rafHandle) return;
    this.rafHandle = window.requestAnimationFrame(() => {
      this.rafHandle = 0;
      this.renderNow();
    });
  }

  private cancelScheduledRender(): void {
    if (!this.rafHandle) return;
    window.cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private renderOverlay(visibleBounds: CadBounds): void {
    const ctx = this.overlayCtx;
    const canvas = this.overlayCanvas;
    if (!ctx || !canvas) return;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    if (this.opts.showPageBounds && this.document?.pages?.length) this.drawPageBoundsOverlay(ctx);
    if (this.scene) {
      this.drawImagesOverlay(ctx, this.scene.imageItems, visibleBounds);
      this.drawTextOverlay(ctx, this.scene.textItems, visibleBounds);
    }
    ctx.restore();
  }

  private drawPageBoundsOverlay(ctx: CanvasRenderingContext2D): void {
    if (!this.document?.pages?.length) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.34)';
    ctx.lineWidth = 1;
    ctx.setLineDash([8, 6]);
    for (const page of this.document.pages) {
      const a = this.worldToScreen({ x: 0, y: 0 });
      const b = this.worldToScreen({ x: page.width, y: page.height });
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    ctx.restore();
  }

  private drawTextOverlay(ctx: CanvasRenderingContext2D, items: TextItem[], visibleBounds: CadBounds): void {
    const maxLabels = this.opts.maxVisibleTextLabels;
    let drawn = 0;
    for (const item of items) {
      if (drawn >= maxLabels) break;
      if (!boundsIntersects(item.bounds, visibleBounds)) continue;
      const pixelHeight = Math.abs(item.height) * this.view.scale;
      if (pixelHeight < this.opts.textMinPixelHeight) continue;
      const s = this.worldToScreen(item.point);
      if (s.x < -512 || s.y < -512 || s.x > this.cssWidth + 512 || s.y > this.cssHeight + 512) continue;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(-item.rotation);
      ctx.scale((item.generationFlag & 2 ? -1 : 1) * item.xScale, item.generationFlag & 4 ? -1 : 1);
      const fontSize = Math.max(4, Math.min(256, pixelHeight));
      ctx.font = `${fontSize}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.fillStyle = item.color;
      ctx.globalAlpha = item.opacity;
      ctx.textAlign = item.halign === 1 || item.halign === 4 ? 'center' : item.halign === 2 ? 'right' : 'left';
      ctx.textBaseline = item.valign === 1 ? 'bottom' : item.valign === 2 ? 'middle' : item.valign === 3 ? 'top' : 'alphabetic';
      for (const [index, line] of item.text.split(/\r?\n/g).entries()) ctx.fillText(line, 0, index * fontSize * 1.22);
      ctx.restore();
      drawn++;
    }
  }

  private drawImagesOverlay(ctx: CanvasRenderingContext2D, items: ImageItem[], visibleBounds: CadBounds): void {
    for (const item of items) {
      if (!boundsIntersects(item.bounds, visibleBounds)) continue;
      const a = this.worldToScreen(item.point);
      const b = this.worldToScreen({ x: item.point.x + item.width, y: item.point.y - item.height });
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const width = Math.abs(b.x - a.x);
      const height = Math.abs(b.y - a.y);
      if (width < 1 || height < 1) continue;
      if (item.source) {
        const image = this.getImage(item.source);
        if (image.complete && image.naturalWidth > 0) {
          ctx.save();
          ctx.globalAlpha = item.opacity;
          ctx.drawImage(image, x, y, width, height);
          ctx.restore();
          continue;
        }
        image.onload = () => this.scheduleRender();
      }
      if (!this.opts.showImagePlaceholders) continue;
      ctx.save();
      ctx.strokeStyle = item.color;
      ctx.globalAlpha = item.opacity;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, width, height);
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x + width, y + height);
      ctx.moveTo(x + width, y); ctx.lineTo(x, y + height);
      ctx.stroke();
      ctx.restore();
    }
  }

  private getImage(src: string): HTMLImageElement {
    let image = this.imageCache.get(src);
    if (!image) {
      image = new Image();
      image.src = src;
      this.imageCache.set(src, image);
    }
    return image;
  }

  private createOverlayCanvas(): void {
    const parent = this.canvas.parentElement;
    if (!parent || typeof document === 'undefined') return;
    const style = window.getComputedStyle(parent);
    if (style.position === 'static') parent.style.position = 'relative';
    const overlay = document.createElement('canvas');
    overlay.className = 'cad-viewer-text-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.position = 'absolute';
    overlay.style.inset = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '1';
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    parent.appendChild(overlay);
    this.overlayCanvas = overlay;
    this.overlayCtx = ctx;
  }

  private resizeOverlay(width: number, height: number): void {
    if (!this.overlayCanvas) return;
    if (this.overlayCanvas.width !== width || this.overlayCanvas.height !== height) {
      this.overlayCanvas.width = width;
      this.overlayCanvas.height = height;
    }
  }

  private bindEvents(): void {
    const signal = this.eventController.signal;
    this.canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? this.opts.wheelZoomFactor : 1 / this.opts.wheelZoomFactor;
      this.zoom(factor, { x: ev.offsetX, y: ev.offsetY });
    }, { passive: false, signal });

    this.canvas.addEventListener('pointerdown', (ev) => {
      this.canvas.setPointerCapture(ev.pointerId);
      this.isDragging = true;
      this.lastPointer = { x: ev.clientX, y: ev.clientY };
      this.canvas.classList.add('is-dragging');
    }, { signal });

    this.canvas.addEventListener('pointermove', (ev) => {
      if (!this.isDragging || !this.lastPointer) return;
      this.panByScreenDelta(ev.clientX - this.lastPointer.x, ev.clientY - this.lastPointer.y);
      this.lastPointer = { x: ev.clientX, y: ev.clientY };
    }, { signal });

    const stopDrag = (ev?: PointerEvent) => {
      if (ev && this.canvas.hasPointerCapture(ev.pointerId)) this.canvas.releasePointerCapture(ev.pointerId);
      this.isDragging = false;
      this.lastPointer = undefined;
      this.canvas.classList.remove('is-dragging');
    };
    this.canvas.addEventListener('pointerup', stopDrag, { signal });
    this.canvas.addEventListener('pointercancel', () => stopDrag(), { signal });
    this.canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.cancelScheduledRender();
    }, { signal });
  }

  private visibleWorldBounds(): CadBounds {
    const halfW = this.cssWidth / Math.max(this.view.scale, 1e-12) / 2;
    const halfH = this.cssHeight / Math.max(this.view.scale, 1e-12) / 2;
    return {
      minX: this.view.centerX - halfW,
      maxX: this.view.centerX + halfW,
      minY: this.view.centerY - halfH,
      maxY: this.view.centerY + halfH
    };
  }

  private get cssWidth(): number { return this.canvas.clientWidth || 1; }
  private get cssHeight(): number { return this.canvas.clientHeight || 1; }

  private clampScale(value: number): number {
    return Math.min(this.opts.maxScale, Math.max(this.opts.minScale, value));
  }

  private boundsOptions() {
    return { maxInsertDepth: this.opts.maxInsertDepth, maxCurveSegments: this.opts.maxCurveSegments };
  }

  private disposeScene(): void {
    if (!this.scene) return;
    const gl = this.gl;
    for (const batch of [...this.scene.lineBatches, ...this.scene.triangleBatches, ...this.scene.lineTypePointBatches, ...this.scene.pointBatches]) {
      gl.deleteBuffer(batch.positionBuffer);
      gl.deleteBuffer(batch.colorBuffer);
    }
    this.scene = undefined;
  }

  private emitViewChange(): void {
    this.onViewChange?.({
      view: this.getViewState(),
      fitScale: this.fitScale,
      zoomRatio: this.getZoomRatio(),
      zoomPercent: this.getZoomPercent(),
      bounds: this.getBounds()
    });
  }
}

export function isWebGLAvailable(): boolean {
  if (typeof document === 'undefined') return false;
  const canvas = document.createElement('canvas');
  return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl'));
}

function createWebGLContext(canvas: HTMLCanvasElement, options: CanvasViewerOptions): GL | undefined {
  const attributes: WebGLContextAttributes = {
    alpha: false,
    antialias: options.antialias ?? true,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
    powerPreference: options.powerPreference ?? 'high-performance'
  };
  return (canvas.getContext('webgl2', attributes) as GL | null)
    ?? (canvas.getContext('webgl', attributes) as GL | null)
    ?? (canvas.getContext('experimental-webgl', attributes) as GL | null)
    ?? undefined;
}

function createProgramInfo(gl: GL): ProgramInfo {
  const vertexSource = `
    attribute vec2 a_position;
    attribute vec4 a_color;
    uniform vec2 u_viewCenter;
    uniform float u_scale;
    uniform vec2 u_viewport;
    uniform float u_pointSize;
    varying vec4 v_color;
    void main() {
      vec2 screen = vec2(
        u_viewport.x * 0.5 + (a_position.x - u_viewCenter.x) * u_scale,
        u_viewport.y * 0.5 - (a_position.y - u_viewCenter.y) * u_scale
      );
      vec2 clip = vec2(screen.x / u_viewport.x * 2.0 - 1.0, 1.0 - screen.y / u_viewport.y * 2.0);
      gl_Position = vec4(clip, 0.0, 1.0);
      gl_PointSize = u_pointSize;
      v_color = a_color;
    }
  `;
  const fragmentSource = `
    precision mediump float;
    varying vec4 v_color;
    void main() {
      gl_FragColor = v_color;
    }
  `;
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('Failed to create WebGL program.');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? 'Unknown WebGL program link error.';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  const uViewCenter = gl.getUniformLocation(program, 'u_viewCenter');
  const uScale = gl.getUniformLocation(program, 'u_scale');
  const uViewport = gl.getUniformLocation(program, 'u_viewport');
  const uPointSize = gl.getUniformLocation(program, 'u_pointSize');
  if (!uViewCenter || !uScale || !uViewport || !uPointSize) throw new Error('Failed to resolve WebGL shader uniforms.');
  return {
    program,
    aPosition: gl.getAttribLocation(program, 'a_position'),
    aColor: gl.getAttribLocation(program, 'a_color'),
    uViewCenter,
    uScale,
    uViewport,
    uPointSize
  };
}

function compileShader(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create WebGL shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'Unknown WebGL shader compile error.';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function uploadScene(gl: GL, cpu: CpuScene): GpuScene {
  let gpuMemoryBytes = 0;
  const upload = (items: CpuBatch[]): GpuBatch[] => items.map((item) => {
    const positionBuffer = createBuffer(gl, item.positions);
    const colorBuffer = createBuffer(gl, item.colors);
    const gpuBytes = item.positions.byteLength + item.colors.byteLength;
    gpuMemoryBytes += gpuBytes;
    return {
      positionBuffer,
      colorBuffer,
      vertexCount: item.positions.length / 2,
      primitiveCount: item.primitiveCount,
      bounds: item.bounds,
      gpuBytes
    };
  });
  const lineBatches = upload(cpu.lineBatches);
  const triangleBatches = upload(cpu.triangleBatches);
  const lineTypePointBatches = upload(cpu.lineTypePointBatches);
  const pointBatches = upload(cpu.pointBatches);
  return {
    origin: cpu.origin,
    lineBatches,
    triangleBatches,
    lineTypePointBatches,
    pointBatches,
    textItems: cpu.textItems,
    imageItems: cpu.imageItems,
    stats: cpu.stats,
    primitiveCount: cpu.primitiveCount,
    gpuMemoryBytes,
    buildElapsedMs: cpu.buildElapsedMs
  };
}

function createBuffer(gl: GL, data: Float32Array | Uint8Array): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('Failed to create WebGL buffer.');
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data as unknown as BufferSource, gl.STATIC_DRAW);
  return buffer;
}

function buildCpuScene(document: CadDocument, opts: Required<CanvasViewerOptions>, bounds: CadBounds): CpuScene {
  const started = performance.now();
  const origin = boundsValid(bounds)
    ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
    : { x: 0, y: 0 };
  const builder = new CpuSceneBuilder(document, opts, bounds, origin);
  for (const entity of document.entities) builder.addEntityTracked(entity, 0);
  const scene = builder.finalize();
  scene.buildElapsedMs = performance.now() - started;
  return scene;
}

class CpuSceneBuilder {
  private readonly lineBuckets = new Map<string, MutableBatch>();
  private readonly triangleBuckets = new Map<string, MutableBatch>();
  private readonly lineTypePointBuckets = new Map<string, MutableBatch>();
  private readonly pointBuckets = new Map<string, MutableBatch>();
  private readonly textItems: TextItem[] = [];
  private readonly imageItems: ImageItem[] = [];
  private readonly stats: Omit<RenderStats, 'renderElapsedMs'> = { total: 0, drawn: 0, skipped: 0, byType: {}, unsupported: {}, backend: 'webgl', primitiveCount: 0, visiblePrimitiveCount: 0, culledPrimitiveCount: 0, gpuMemoryBytes: 0, buildElapsedMs: 0 };
  private readonly tileSize: number;
  private readonly maxVerticesPerBatch: number;
  private primitiveCount = 0;

  constructor(private readonly document: CadDocument, private readonly opts: Required<CanvasViewerOptions>, private readonly bounds: CadBounds, private readonly origin: CadPoint2D) {
    const width = boundsValid(bounds) ? Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1e-9) : 1;
    this.tileSize = opts.enableSpatialIndex ? width / Math.max(8, opts.spatialIndexCellCount) : Number.POSITIVE_INFINITY;
    this.maxVerticesPerBatch = Math.max(4096, Math.floor(opts.maxVerticesPerBatch));
  }

  addEntityTracked(entity: CadEntity, depth: number): void {
    this.stats.total++;
    const type = String(entity.type ?? 'UNKNOWN').toUpperCase();
    this.stats.byType[type] = (this.stats.byType[type] ?? 0) + 1;
    const layer = this.lookupLayer(entity.layer);
    if (entity.isVisible === false || !layerVisible(layer)) {
      this.stats.skipped++;
      return;
    }
    this.addEntity(entity, type, depth);
  }

  finalize(): CpuScene {
    const lineBatches = finalizeMutableBatches(this.lineBuckets, this.maxVerticesPerBatch);
    const triangleBatches = finalizeMutableBatches(this.triangleBuckets, this.maxVerticesPerBatch);
    const lineTypePointBatches = finalizeMutableBatches(this.lineTypePointBuckets, this.maxVerticesPerBatch);
    const pointBatches = finalizeMutableBatches(this.pointBuckets, this.maxVerticesPerBatch);
    this.stats.primitiveCount = this.primitiveCount;
    return {
      origin: this.origin,
      lineBatches,
      triangleBatches,
      lineTypePointBatches,
      pointBatches,
      textItems: this.textItems,
      imageItems: this.imageItems,
      stats: this.stats,
      primitiveCount: this.primitiveCount,
      buildElapsedMs: 0
    };
  }

  private addEntity(entity: CadEntity, type: string, depth: number): void {
    const kind = entity.kind ?? inferEntityKind(type);
    switch (kind) {
      case 'line': return this.addLineEntity(entity);
      case 'circle': return this.addCircleEntity(entity);
      case 'arc': return this.addArcEntity(entity);
      case 'polyline': return this.addPolylineEntity(entity);
      case 'ellipse': return this.addEllipseEntity(entity);
      case 'text': return this.addTextEntity(entity);
      case 'point': return this.addPointEntity(entity);
      case 'insert': return this.addInsertEntity(entity, depth);
      case 'solid': return this.addSolidEntity(entity);
      case 'hatch': return this.addHatchEntity(entity);
      case 'spline': return this.addSplineEntity(entity);
      case 'path': return this.addPathEntity(entity);
      case 'image': return this.addImageEntity(entity);
      case 'viewport': return this.markSkipped(type);
      default:
        this.stats.unsupported[type] = (this.stats.unsupported[type] ?? 0) + 1;
        this.stats.skipped++;
        if (this.opts.showUnsupportedMarkers) this.addUnsupportedMarker(entity);
    }
  }

  private addLineEntity(e: CadEntity): void {
    if (!isFinitePoint(e.startPoint) || !isFinitePoint(e.endPoint)) return this.markSkipped('LINE');
    this.addPolyline([e.startPoint, e.endPoint], false, this.strokeBytes(e), e);
    this.stats.drawn++;
  }

  private addCircleEntity(e: CadEntity): void {
    const center = e.center;
    const radius = Number(e.radius);
    if (!isFinitePoint(center) || !Number.isFinite(radius)) return this.markSkipped('CIRCLE');
    const segments = Math.max(16, Math.min(this.opts.maxCurveSegments, Math.ceil(Math.sqrt(Math.abs(radius)) * 12)));
    const pts = arcPoints(center, radius, 0, Math.PI * 2, true, segments);
    this.addPolyline(pts, true, this.strokeBytes(e), e);
    this.stats.drawn++;
  }

  private addArcEntity(e: CadEntity): void {
    const center = e.center;
    const radius = Number(e.radius);
    const startAngle = Number(e.startAngle);
    const endAngle = Number(e.endAngle);
    if (!isFinitePoint(center) || !Number.isFinite(radius) || !Number.isFinite(startAngle) || !Number.isFinite(endAngle)) return this.markSkipped('ARC');
    this.addPolyline(arcPoints(center, radius, startAngle, endAngle, true, this.opts.maxCurveSegments), false, this.strokeBytes(e), e);
    this.stats.drawn++;
  }

  private addPolylineEntity(e: CadEntity): void {
    const vertices = (e.vertices ?? e.points) as Array<CadPoint3D & { bulge?: number }> | undefined;
    if (!Array.isArray(vertices) || vertices.length < 2) return this.markSkipped(String(e.type));
    const closed = isCadPolylineClosed(e);
    const pts: CadPoint2D[] = [];
    const pairs = closed ? vertices.length : vertices.length - 1;
    for (let i = 0; i < pairs; i++) {
      const p1 = vertices[i];
      const p2 = vertices[(i + 1) % vertices.length];
      if (!isFinitePoint(p1) || !isFinitePoint(p2)) continue;
      const segment = bulgeToPolylinePoints(p1, p2, Number(p1.bulge ?? 0), Math.max(4, Math.min(24, this.opts.maxCurveSegments / 4)));
      if (pts.length > 0) segment.shift();
      pts.push(...segment);
    }
    if (pts.length < 2) return this.markSkipped(String(e.type));
    this.addPolyline(pts, closed, this.strokeBytes(e), e);
    this.stats.drawn++;
  }

  private addEllipseEntity(e: CadEntity): void {
    if (!isFinitePoint(e.center) || !isFinitePoint(e.majorAxisEndPoint)) return this.markSkipped('ELLIPSE');
    const pts = ellipsePoints(e.center, e.majorAxisEndPoint, Number(e.axisRatio ?? 1), Number(e.startAngle ?? 0), Number(e.endAngle ?? Math.PI * 2), this.opts.maxCurveSegments);
    const closed = Math.abs(Number(e.endAngle ?? Math.PI * 2) - Number(e.startAngle ?? 0)) >= Math.PI * 2 - 1e-6;
    this.addPolyline(pts, closed, this.strokeBytes(e), e);
    this.stats.drawn++;
  }

  private addTextEntity(e: CadEntity): void {
    const halign = Number(e.halign ?? 0);
    const valign = Number(e.valign ?? 0);
    const aligned = (halign !== 0 || valign !== 0) && isFinitePoint(e.endPoint);
    const p = (aligned ? e.endPoint : e.insertionPoint ?? e.startPoint ?? e.center) as CadPoint3D | undefined;
    const text = stripMTextFormatting(String(e.text ?? e.value ?? ''));
    const height = Number(e.textHeight ?? e.height ?? 1);
    if (!isFinitePoint(p) || !text || !Number.isFinite(height)) return this.markSkipped(String(e.type));
    const point = xy(p);
    const xScale = Number(e.xScale ?? 1);
    const safeXScale = Number.isFinite(xScale) && Math.abs(xScale) > 1e-9 ? Math.abs(xScale) : 1;
    const approxWidth = Math.max(1, text.split(/\r?\n/g).reduce((max, line) => Math.max(max, line.length), 0)) * Math.abs(height) * 0.62 * safeXScale;
    const approxHeight = Math.max(1, text.split(/\r?\n/g).length) * Math.abs(height) * 1.22;
    this.textItems.push({
      point,
      text,
      height,
      rotation: Number(e.rotation ?? 0),
      xScale: safeXScale,
      generationFlag: Number(e.generationFlag ?? 0),
      halign,
      valign,
      color: resolveCadColor(e, this.document, this.colorOptions()),
      opacity: clamp(Number(e.opacity ?? 1), 0, 1),
      bounds: { minX: point.x - approxWidth, minY: point.y - approxHeight, maxX: point.x + approxWidth, maxY: point.y + approxHeight }
    });
    this.stats.drawn++;
  }

  private addPointEntity(e: CadEntity): void {
    const p = (e.point ?? e.location ?? e.center ?? e.insertionPoint) as CadPoint3D | undefined;
    if (!isFinitePoint(p)) return this.markSkipped('POINT');
    this.addPoint(p, this.strokeBytes(e));
    this.stats.drawn++;
  }

  private addInsertEntity(e: CadEntity, depth: number): void {
    const block = this.lookupBlock(e.blockName ?? e.name);
    if (block && depth < this.opts.maxInsertDepth) {
      const matrix = matrixFromInsert(e, block.basePoint ?? { x: 0, y: 0 });
      for (const child of block.entities) {
        const inheritedColor = applyByBlockColorInheritance(child, e, this.document, this.colorOptions());
        const inherited = applyByBlockLineTypeInheritance(inheritedColor, e, this.document);
        this.addEntityTracked(transformEntity(inherited, matrix), depth + 1);
      }
      return;
    }
    const p = e.insertionPoint;
    if (!isFinitePoint(p)) return this.markSkipped('INSERT');
    this.addPoint(p, this.strokeBytes(e));
    if (Array.isArray(e.attribs)) for (const attr of e.attribs) this.addTextEntity(attr);
    this.stats.drawn++;
  }

  private addSolidEntity(e: CadEntity): void {
    const vertices = (e.vertices ?? e.points) as CadPoint3D[] | undefined;
    if (!Array.isArray(vertices) || vertices.length < 3) return this.markSkipped(String(e.type));
    const points = vertices.filter(isFinitePoint).map(xy);
    if (points.length < 3) return this.markSkipped(String(e.type));
    const fill = this.fillBytes(e) ?? this.strokeBytes(e);
    this.addTriangleFan(points, fill);
    this.addPolyline(points, true, this.strokeBytes(e), e);
    this.stats.drawn++;
  }

  private addHatchEntity(e: CadEntity): void {
    const loops = e.loops;
    if (!Array.isArray(loops) || loops.length === 0) return this.markSkipped('HATCH');
    const stroke = this.strokeBytes(e);
    const fill = this.fillBytes(e);
    let added = false;
    for (const loop of loops) {
      const points = loop.commands?.length ? flattenPathCommands(loop.commands, this.opts.maxCurveSegments) : (loop.vertices ?? []).filter(isFinitePoint).map(xy);
      if (points.length < 2) continue;
      this.addPolyline(points, true, stroke, e);
      if (fill && points.length >= 3) this.addTriangleFan(points, fill);
      added = true;
    }
    if (!added) return this.markSkipped('HATCH');
    this.stats.drawn++;
  }

  private addSplineEntity(e: CadEntity): void {
    const points = e.fitPoints?.length ? e.fitPoints : e.controlPoints;
    if (!points || points.length < 2) return this.markSkipped('SPLINE');
    this.addPolyline(points.filter(isFinitePoint).map(xy), Boolean(e.isClosed), this.strokeBytes(e), e);
    this.stats.drawn++;
  }

  private addPathEntity(e: CadEntity): void {
    if (!e.commands?.length) return this.markSkipped(String(e.type));
    const points = flattenPathCommands(e.commands, this.opts.maxCurveSegments);
    if (points.length < 2) return this.markSkipped(String(e.type));
    this.addPolyline(points, false, this.strokeBytes(e), e);
    const fill = this.fillBytes(e);
    if (fill && points.length >= 3) this.addTriangleFan(points, fill);
    this.stats.drawn++;
  }

  private addImageEntity(e: CadEntity): void {
    const p = e.insertionPoint;
    if (!isFinitePoint(p)) return this.markSkipped(String(e.type));
    const width = Number(e.width ?? 32);
    const height = Number(e.height ?? 32);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return this.markSkipped(String(e.type));
    const point = xy(p);
    const bounds = boundsFromPoints([point, { x: point.x + width, y: point.y - height }]);
    this.imageItems.push({ point, width, height, source: e.imageDataUrl ?? e.imageSource, color: resolveCadColor(e, this.document, this.colorOptions()), opacity: clamp(Number(e.opacity ?? 1), 0, 1), bounds });
    this.stats.drawn++;
  }

  private addUnsupportedMarker(e: CadEntity): void {
    const p = entityAnchor(e);
    if (!p) return;
    this.addPoint(p, this.strokeBytes(e));
  }

  private addPolyline(points: CadPoint2D[], closed: boolean, color: RgbaBytes, entity?: CadEntity): void {
    const valid = points.filter(isFinitePoint).map(xy);
    if (valid.length < 2) return;
    if (closed && pointsEqual(valid[0], valid[valid.length - 1])) valid.pop();
    if (valid.length < 2) return;
    const worldWidth = entity ? cadEntityWorldStrokeWidth(entity) : 0;
    const pattern = entity ? resolveCadLinePattern(entity, this.document) : undefined;
    if (pattern) {
      const primitives = createDashedCadPrimitives(valid, closed, pattern);
      const fallbackDots = [...primitives.dots];
      for (const [start, end] of primitives.segments) {
        this.addSegment(start, end, color);
        if (worldWidth > 1e-9) this.addWideSegment(start, end, worldWidth, color, true);
      }
      for (const marker of primitives.markers ?? []) {
        const glyph = this.resolveLineTypeGlyph(marker);
        if (!glyph) continue;
        removeMatchingPoint(fallbackDots, marker.fallbackPoint);
        let added = false;
        for (const polyline of transformCadLineTypeGlyph(marker, glyph)) {
          for (let index = 0; index < polyline.length - 1; index++) {
            this.addSegment(polyline[index], polyline[index + 1], color);
            added = true;
          }
        }
        if (!added) fallbackDots.push(marker.point);
      }
      for (const point of fallbackDots) this.addLineTypePoint(point, color);
      return;
    }
    for (let i = 0; i < valid.length - 1; i++) this.addSegment(valid[i], valid[i + 1], color);
    if (closed) this.addSegment(valid[valid.length - 1], valid[0], color);
    if (worldWidth > 1e-9) this.addWidePolyline(valid, closed, worldWidth, color);
  }

  private addWidePolyline(points: CadPoint2D[], closed: boolean, width: number, color: RgbaBytes): void {
    for (let index = 0; index < points.length - 1; index++) this.addWideSegment(points[index], points[index + 1], width, color, false);
    if (closed) this.addWideSegment(points[points.length - 1], points[0], width, color, false);
    for (const point of points) this.addWideDisc(point, width / 2, color);
  }

  private addWideSegment(a: CadPoint2D, b: CadPoint2D, width: number, color: RgbaBytes, roundCaps: boolean): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length <= 1e-14) return;
    const half = Math.abs(width) / 2;
    const nx = -dy / length * half;
    const ny = dx / length * half;
    this.addTriangleFan([
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny }
    ], color);
    if (roundCaps) {
      this.addWideDisc(a, half, color);
      this.addWideDisc(b, half, color);
    }
  }

  private addWideDisc(center: CadPoint2D, radius: number, color: RgbaBytes): void {
    if (!Number.isFinite(radius) || radius <= 1e-9) return;
    const ring: CadPoint2D[] = [];
    const segments = 8;
    for (let index = 0; index < segments; index++) {
      const angle = index / segments * Math.PI * 2;
      ring.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    }
    this.addTriangleFan([center, ...ring, ring[0]], color);
  }

  private addSegment(a: CadPoint2D, b: CadPoint2D, color: RgbaBytes): void {
    if (!isFinitePoint(a) || !isFinitePoint(b)) return;
    if (Math.hypot(a.x - b.x, a.y - b.y) <= 1e-14) return;
    const bucket = this.batchFor(this.lineBuckets, boundsFromPoints([a, b]));
    pushVertex(bucket, a, color, this.origin);
    pushVertex(bucket, b, color, this.origin);
    bucket.primitiveCount++;
    this.primitiveCount++;
  }

  private addPoint(p: CadPoint2D, color: RgbaBytes): void {
    const bucket = this.batchFor(this.pointBuckets, pointBounds(p));
    pushVertex(bucket, p, color, this.origin);
    bucket.primitiveCount++;
    this.primitiveCount++;
  }

  private addLineTypePoint(p: CadPoint2D, color: RgbaBytes): void {
    const bucket = this.batchFor(this.lineTypePointBuckets, pointBounds(p));
    pushVertex(bucket, p, color, this.origin);
    bucket.primitiveCount++;
    this.primitiveCount++;
  }

  private resolveLineTypeGlyph(marker: CadLineTypeMarker): CadShxGlyph | undefined {
    return marker.kind === 'shape'
      ? this.opts.shxGlyphResolver.resolveShape(Number(marker.shapeNumber), marker.fontName)
      : this.opts.shxGlyphResolver.resolveText(String(marker.text ?? ''), marker.fontName);
  }

  private addTriangleFan(points: CadPoint2D[], color: RgbaBytes): void {
    const valid = points.filter(isFinitePoint).map(xy);
    if (valid.length < 3) return;
    const bounds = boundsFromPoints(valid);
    const bucket = this.batchFor(this.triangleBuckets, bounds);
    for (let i = 1; i < valid.length - 1; i++) {
      pushVertex(bucket, valid[0], color, this.origin);
      pushVertex(bucket, valid[i], color, this.origin);
      pushVertex(bucket, valid[i + 1], color, this.origin);
      bucket.primitiveCount++;
      this.primitiveCount++;
    }
  }

  private batchFor(buckets: Map<string, MutableBatch>, bounds: CadBounds): MutableBatch {
    const key = this.bucketKey(bounds);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = createMutableBatch();
      buckets.set(key, bucket);
    }
    includePoint(bucket.bounds, { x: bounds.minX, y: bounds.minY });
    includePoint(bucket.bounds, { x: bounds.maxX, y: bounds.maxY });
    return bucket;
  }

  private bucketKey(bounds: CadBounds): string {
    if (!Number.isFinite(this.tileSize)) return 'all';
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const ix = Math.floor((cx - this.bounds.minX) / this.tileSize);
    const iy = Math.floor((cy - this.bounds.minY) / this.tileSize);
    return `${ix}:${iy}`;
  }

  private strokeBytes(e: CadEntity): RgbaBytes {
    return cssToRgbaBytes(resolveCadColor(e, this.document, this.colorOptions()), [255, 255, 255, 255], clamp(Number(e.opacity ?? 1), 0, 1));
  }

  private fillBytes(e: CadEntity): RgbaBytes | undefined {
    const color = resolveFillColor(e, this.document, this.colorOptions());
    return color ? cssToRgbaBytes(color, [255, 255, 255, 255], clamp(Number(e.opacity ?? 1), 0, 1)) : undefined;
  }

  private colorOptions() {
    return { foreground: this.opts.foreground, background: this.opts.background, trueColorByteOrder: this.opts.trueColorByteOrder, contrastMode: this.opts.contrastMode, minColorContrast: this.opts.minColorContrast };
  }

  private markSkipped(type: string): void {
    this.stats.skipped++;
    this.stats.unsupported[type] = this.stats.unsupported[type] ?? 0;
  }

  private lookupLayer(name: string | undefined) {
    if (!name) return undefined;
    return this.document.layers[name] ?? this.document.layers[name.toLowerCase()] ?? Object.values(this.document.layers).find((layer) => layer.name.toLowerCase() === name.toLowerCase());
  }

  private lookupBlock(name: string | undefined): CadBlock | undefined {
    if (!name) return undefined;
    return this.document.blocks[name] ?? this.document.blocks[name.toLowerCase()] ?? Object.values(this.document.blocks).find((block) => block.name.toLowerCase() === name.toLowerCase());
  }
}

interface MutableBatch {
  positions: number[];
  colors: number[];
  bounds: CadBounds;
  primitiveCount: number;
}

function createMutableBatch(): MutableBatch {
  return { positions: [], colors: [], bounds: emptyBounds(), primitiveCount: 0 };
}

function pushVertex(batch: MutableBatch, point: CadPoint2D, color: RgbaBytes, origin: CadPoint2D): void {
  batch.positions.push(point.x - origin.x, point.y - origin.y);
  batch.colors.push(color[0], color[1], color[2], color[3]);
}

function finalizeMutableBatches(map: Map<string, MutableBatch>, maxVerticesPerBatch: number): CpuBatch[] {
  const out: CpuBatch[] = [];
  for (const batch of map.values()) {
    const vertexCount = batch.positions.length / 2;
    if (vertexCount <= 0 || !boundsValid(batch.bounds)) continue;
    if (vertexCount <= maxVerticesPerBatch) {
      out.push({ positions: new Float32Array(batch.positions), colors: new Uint8Array(batch.colors), bounds: { ...batch.bounds }, primitiveCount: batch.primitiveCount });
      continue;
    }
    const primitiveSize = inferPrimitiveSize(batch);
    const verticesPerChunk = Math.max(primitiveSize, Math.floor(maxVerticesPerBatch / primitiveSize) * primitiveSize);
    for (let startVertex = 0; startVertex < vertexCount; startVertex += verticesPerChunk) {
      const endVertex = Math.min(vertexCount, startVertex + verticesPerChunk);
      const p = batch.positions.slice(startVertex * 2, endVertex * 2);
      const c = batch.colors.slice(startVertex * 4, endVertex * 4);
      const bounds = emptyBounds();
      for (let i = 0; i < p.length; i += 2) includePoint(bounds, { x: p[i], y: p[i + 1] });
      // Chunk bounds are local here; widen to parent batch bounds to avoid culling errors for split primitives.
      out.push({ positions: new Float32Array(p), colors: new Uint8Array(c), bounds: { ...batch.bounds }, primitiveCount: Math.floor((endVertex - startVertex) / primitiveSize) });
    }
  }
  return out;
}

function inferPrimitiveSize(batch: MutableBatch): 1 | 2 | 3 {
  const vertices = batch.positions.length / 2;
  if (vertices === batch.primitiveCount) return 1;
  if (vertices === batch.primitiveCount * 3) return 3;
  return 2;
}

function flattenPathCommands(commands: CadPathCommand[], segments: number): CadPoint2D[] {
  const points: CadPoint2D[] = [];
  let current: CadPoint2D | undefined;
  let start: CadPoint2D | undefined;
  const push = (point: CadPoint2D) => {
    if (!points.length || Math.hypot(points[points.length - 1].x - point.x, points[points.length - 1].y - point.y) > 1e-12) points.push(xy(point));
    current = xy(point);
  };
  for (const command of commands) {
    if (command.cmd === 'M') {
      current = xy(command.points[0]);
      start = current;
      push(current);
    } else if (command.cmd === 'L') {
      push(command.points[0]);
    } else if (command.cmd === 'Q' && current && command.points.length >= 2) {
      const p0 = current;
      const [c, end] = command.points;
      const n = Math.max(4, Math.min(segments, 24));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const mt = 1 - t;
        push({ x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * end.x, y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * end.y });
      }
    } else if (command.cmd === 'C' && current && command.points.length >= 3) {
      const p0 = current;
      const [c1, c2, end] = command.points;
      const n = Math.max(6, Math.min(segments, 32));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const mt = 1 - t;
        push({
          x: mt ** 3 * p0.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * end.x,
          y: mt ** 3 * p0.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * end.y
        });
      }
    } else if (command.cmd === 'Z' && start) {
      push(start);
    }
  }
  return points;
}

function entityAnchor(e: CadEntity): CadPoint2D | undefined {
  for (const key of ['startPoint', 'insertionPoint', 'center', 'point', 'location']) {
    const p = e[key];
    if (isFinitePoint(p)) return xy(p);
  }
  if (Array.isArray(e.vertices) && isFinitePoint(e.vertices[0])) return xy(e.vertices[0]);
  if (Array.isArray(e.commands) && e.commands.length) {
    const cmd = e.commands.find((item) => item.points.length > 0);
    if (cmd) return xy(cmd.points[0]);
  }
  return undefined;
}

function boundsFromPoints(points: CadPoint2D[]): CadBounds {
  const bounds = emptyBounds();
  for (const point of points) includePoint(bounds, point);
  return bounds;
}

function pointsEqual(a: CadPoint2D, b: CadPoint2D): boolean {
  const extent = Math.max(1, Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y));
  return Math.hypot(a.x - b.x, a.y - b.y) <= Math.max(1e-9, extent * 1e-12);
}

function removeMatchingPoint(points: CadPoint2D[], target: CadPoint2D): void {
  const index = points.findIndex((point) => pointsEqual(point, target));
  if (index >= 0) points.splice(index, 1);
}

function pointBounds(point: CadPoint2D): CadBounds {
  return { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
}

function boundsIntersects(a: CadBounds, b: CadBounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function requiresSceneRebuild(current: Required<CanvasViewerOptions>, next: CanvasViewerOptions): boolean {
  return next.trueColorByteOrder !== undefined && next.trueColorByteOrder !== current.trueColorByteOrder
    || next.contrastMode !== undefined && next.contrastMode !== current.contrastMode
    || next.minColorContrast !== undefined && next.minColorContrast !== current.minColorContrast
    || next.foreground !== undefined && next.foreground !== current.foreground
    || next.background !== undefined && next.background !== current.background
    || next.maxInsertDepth !== undefined && next.maxInsertDepth !== current.maxInsertDepth
    || next.maxCurveSegments !== undefined && next.maxCurveSegments !== current.maxCurveSegments
    || next.spatialIndexCellCount !== undefined && next.spatialIndexCellCount !== current.spatialIndexCellCount
    || next.maxVerticesPerBatch !== undefined && next.maxVerticesPerBatch !== current.maxVerticesPerBatch
    || next.enableSpatialIndex !== undefined && next.enableSpatialIndex !== current.enableSpatialIndex
    || next.shxGlyphResolver !== undefined && next.shxGlyphResolver !== current.shxGlyphResolver;
}

function createStatsFromScene(scene: GpuScene, renderElapsedMs: number): RenderStats {
  return { ...scene.stats, renderElapsedMs, backend: 'webgl', primitiveCount: scene.primitiveCount, visiblePrimitiveCount: 0, culledPrimitiveCount: 0, gpuMemoryBytes: scene.gpuMemoryBytes, buildElapsedMs: scene.buildElapsedMs };
}

function cloneStats(stats: RenderStats): RenderStats {
  return {
    total: stats.total,
    drawn: stats.drawn,
    skipped: stats.skipped,
    byType: { ...stats.byType },
    unsupported: { ...stats.unsupported },
    renderElapsedMs: stats.renderElapsedMs,
    backend: stats.backend,
    primitiveCount: stats.primitiveCount,
    visiblePrimitiveCount: stats.visiblePrimitiveCount,
    culledPrimitiveCount: stats.culledPrimitiveCount,
    gpuMemoryBytes: stats.gpuMemoryBytes,
    buildElapsedMs: stats.buildElapsedMs
  };
}

function cssToRgbaBytes(value: string, fallback: RgbaBytes, opacity = 1): RgbaBytes {
  const text = value.trim().toLowerCase();
  let rgba: RgbaBytes | undefined;
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    rgba = [parseInt(text[1] + text[1], 16), parseInt(text[2] + text[2], 16), parseInt(text[3] + text[3], 16), 255];
  } else if (/^#[0-9a-f]{6}$/i.test(text)) {
    rgba = [parseInt(text.slice(1, 3), 16), parseInt(text.slice(3, 5), 16), parseInt(text.slice(5, 7), 16), 255];
  } else {
    const match = text.match(/^rgba?\(([^)]+)\)$/i);
    if (match) {
      const raw = match[1].split(/[\s,\/]+/).filter(Boolean);
      const percent = raw.slice(0, 3).some((part) => part.includes('%'));
      const nums = raw.map((part) => Number(part.replace('%', '')));
      if (nums.length >= 3 && nums.slice(0, 3).every(Number.isFinite)) {
        rgba = [clampByte(percent ? nums[0] * 2.55 : nums[0]), clampByte(percent ? nums[1] * 2.55 : nums[1]), clampByte(percent ? nums[2] * 2.55 : nums[2]), clampByte((Number.isFinite(nums[3]) ? nums[3] : 1) * 255)];
      }
    }
  }
  const out = rgba ?? fallback;
  return [out[0], out[1], out[2], clampByte(out[3] * opacity)];
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
