import { applyByBlockColorInheritance, layerVisible, resolveCadColor, resolveFillColor, type CadColorContrastMode } from '../core/color';
import { arcPoints, boundsValid, bulgeToPolylinePoints, clamp, ellipsePoints, emptyBounds, includeCircle, includePoint, isFinitePoint, paddedBounds, stripMTextFormatting, xy } from '../core/geometry';
import { inferEntityKind } from '../core/entity';
import { matrixFromInsert, transformEntity } from '../core/transform';
import type { CadBlock, CadBounds, CadDocument, CadEntity, CadPathCommand, CadPoint2D, CadPoint3D } from '../core/types';

export interface CanvasViewerOptions {
  background?: string;
  foreground?: string;
  showUnsupportedMarkers?: boolean;
  showImagePlaceholders?: boolean;
  showPageBounds?: boolean;
  minScale?: number;
  maxScale?: number;
  wheelZoomFactor?: number;
  trueColorByteOrder?: 'rgb' | 'bgr';
  maxInsertDepth?: number;
  contrastMode?: CadColorContrastMode;
  minColorContrast?: number;

  /** WebGL renderer: approximate curve tessellation cap for circles/arcs/ellipses. */
  maxCurveSegments?: number;
  /** WebGL renderer: target number of spatial cells across the longest drawing axis. */
  spatialIndexCellCount?: number;
  /** WebGL renderer: maximum vertices per GPU batch. Smaller values improve culling granularity. */
  maxVerticesPerBatch?: number;
  /** WebGL renderer: hide labels below this screen-space height. */
  textMinPixelHeight?: number;
  /** WebGL renderer: cap the number of labels drawn into the 2D overlay per frame. */
  maxVisibleTextLabels?: number;
  /** WebGL renderer: WebGL context power preference. */
  powerPreference?: WebGLPowerPreference;
  /** WebGL renderer: request antialiasing from the WebGL context. */
  antialias?: boolean;
  /** WebGL renderer: keep WebGL framebuffer pixels after rendering. Usually false for speed. */
  preserveDrawingBuffer?: boolean;
  /** WebGL renderer: use retained, spatially culled GPU batches. */
  enableSpatialIndex?: boolean;
}

export interface ViewState {
  centerX: number;
  centerY: number;
  scale: number;
}

export interface RenderStats {
  total: number;
  drawn: number;
  skipped: number;
  byType: Record<string, number>;
  unsupported: Record<string, number>;
  renderElapsedMs: number;
  /** Active renderer backend. */
  backend?: 'canvas2d' | 'webgl';
  /** Total retained GPU/CPU primitives after scene normalization. */
  primitiveCount?: number;
  /** Primitives submitted in the latest frame after viewport culling. */
  visiblePrimitiveCount?: number;
  /** Primitives skipped by viewport culling in the latest frame. */
  culledPrimitiveCount?: number;
  /** Estimated GPU buffer memory in bytes. */
  gpuMemoryBytes?: number;
  /** One-time retained scene build/upload time in milliseconds. */
  buildElapsedMs?: number;
}

export interface ViewChangeEvent {
  view: ViewState;
  fitScale: number;
  zoomRatio: number;
  zoomPercent: number;
  bounds: CadBounds;
}

const DEFAULT_OPTIONS: Required<CanvasViewerOptions> = {
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
  enableSpatialIndex: true
};

export class CadCanvasRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly opts: Required<CanvasViewerOptions>;
  private document?: CadDocument;
  private bounds: CadBounds = emptyBounds();
  private view: ViewState = { centerX: 0, centerY: 0, scale: 1 };
  private fitScale = 1;
  private dpr = 1;
  private isDragging = false;
  private lastPointer?: { x: number; y: number };
  private resizeObserver?: ResizeObserver;
  private imageCache = new Map<string, HTMLImageElement>();
  private stats: RenderStats = { total: 0, drawn: 0, skipped: 0, byType: {}, unsupported: {}, renderElapsedMs: 0, backend: 'canvas2d' };

  onStats?: (stats: RenderStats) => void;
  onViewChange?: (event: ViewChangeEvent) => void;

  constructor(canvas: HTMLCanvasElement, options: CanvasViewerOptions = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is not available.');
    this.canvas = canvas;
    this.ctx = ctx;
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.canvas.classList.add('cad-viewer-canvas');
    this.bindEvents();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    this.resize();
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
  }

  clear(): void {
    this.document = undefined;
    this.bounds = emptyBounds();
    this.view = { centerX: 0, centerY: 0, scale: 1 };
    this.fitScale = 1;
    this.render();
    this.emitViewChange();
  }

  setDocument(document: CadDocument): void {
    this.document = document;
    this.bounds = this.computeBounds(document);
    this.fitToView();
  }

  getDocument(): CadDocument | undefined {
    return this.document;
  }

  setOptions(options: CanvasViewerOptions): void {
    Object.assign(this.opts, options);
    this.render();
    this.emitViewChange();
  }

  getOptions(): Required<CanvasViewerOptions> {
    return { ...this.opts };
  }

  fitToView(padding = 0.92): void {
    if (!boundsValid(this.bounds)) {
      this.view = { centerX: 0, centerY: 0, scale: 1 };
      this.fitScale = 1;
      this.render();
      this.emitViewChange();
      return;
    }
    const w = Math.max(1, this.cssWidth);
    const h = Math.max(1, this.cssHeight);
    const bw = Math.max(this.bounds.maxX - this.bounds.minX, 1e-9);
    const bh = Math.max(this.bounds.maxY - this.bounds.minY, 1e-9);
    const scale = this.clampScale(Math.min(w / bw, h / bh) * padding);
    this.fitScale = scale;
    this.view = {
      centerX: (this.bounds.minX + this.bounds.maxX) / 2,
      centerY: (this.bounds.minY + this.bounds.maxY) / 2,
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
    this.render();
    this.emitViewChange();
  }

  zoomIn(): void { this.zoom(this.opts.wheelZoomFactor); }
  zoomOut(): void { this.zoom(1 / this.opts.wheelZoomFactor); }

  panByScreenDelta(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.view.centerX -= dx / this.view.scale;
    this.view.centerY += dy / this.view.scale;
    this.render();
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
    const started = performance.now();
    this.stats = { total: 0, drawn: 0, skipped: 0, byType: {}, unsupported: {}, renderElapsedMs: 0, backend: 'canvas2d' };
    this.clearCanvas();
    if (this.document) {
      if (this.opts.showPageBounds && this.document.pages?.length) this.drawPageBounds(this.document);
      for (const entity of this.document.entities) this.drawEntityTracked(entity, 0);
    }
    this.stats.renderElapsedMs = performance.now() - started;
    this.onStats?.(this.getStats());
    return this.getStats();
  }

  private get cssWidth(): number { return this.canvas.clientWidth || 1; }
  private get cssHeight(): number { return this.canvas.clientHeight || 1; }

  private bindEvents(): void {
    this.canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? this.opts.wheelZoomFactor : 1 / this.opts.wheelZoomFactor;
      this.zoom(factor, { x: ev.offsetX, y: ev.offsetY });
    }, { passive: false });

    this.canvas.addEventListener('pointerdown', (ev) => {
      this.canvas.setPointerCapture(ev.pointerId);
      this.isDragging = true;
      this.lastPointer = { x: ev.clientX, y: ev.clientY };
      this.canvas.classList.add('is-dragging');
    });
    this.canvas.addEventListener('pointermove', (ev) => {
      if (!this.isDragging || !this.lastPointer) return;
      this.panByScreenDelta(ev.clientX - this.lastPointer.x, ev.clientY - this.lastPointer.y);
      this.lastPointer = { x: ev.clientX, y: ev.clientY };
    });
    const stopDrag = (ev?: PointerEvent) => {
      if (ev && this.canvas.hasPointerCapture(ev.pointerId)) this.canvas.releasePointerCapture(ev.pointerId);
      this.isDragging = false;
      this.lastPointer = undefined;
      this.canvas.classList.remove('is-dragging');
    };
    this.canvas.addEventListener('pointerup', stopDrag);
    this.canvas.addEventListener('pointercancel', () => stopDrag());
  }

  private clearCanvas(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.fillStyle = this.opts.background;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.restore();
  }

  private drawPageBounds(document: CadDocument): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([8, 6]);
    for (const page of document.pages ?? []) {
      const a = this.worldToScreen({ x: 0, y: 0 });
      const b = this.worldToScreen({ x: page.width, y: page.height });
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    ctx.restore();
  }

  private drawEntityTracked(entity: CadEntity, depth: number): void {
    this.stats.total++;
    const type = String(entity.type ?? 'UNKNOWN').toUpperCase();
    this.stats.byType[type] = (this.stats.byType[type] ?? 0) + 1;
    const layer = this.lookupLayer(entity.layer);
    if (entity.isVisible === false || !layerVisible(layer)) {
      this.stats.skipped++;
      return;
    }
    this.drawEntity(entity, type, depth);
  }

  private drawEntity(entity: CadEntity, type: string, depth: number): void {
    const kind = entity.kind ?? inferEntityKind(type);
    switch (kind) {
      case 'line': return this.drawLine(entity);
      case 'circle': return this.drawCircle(entity);
      case 'arc': return this.drawArc(entity);
      case 'polyline': return this.drawPolyline(entity);
      case 'ellipse': return this.drawEllipse(entity);
      case 'text': return this.drawText(entity);
      case 'point': return this.drawPoint(entity);
      case 'insert': return this.drawInsert(entity, depth);
      case 'solid': return this.drawSolid(entity);
      case 'hatch': return this.drawHatch(entity);
      case 'spline': return this.drawSpline(entity);
      case 'path': return this.drawPath(entity);
      case 'image': return this.drawImage(entity);
      case 'viewport': return this.markSkipped(type);
      default:
        this.stats.unsupported[type] = (this.stats.unsupported[type] ?? 0) + 1;
        this.stats.skipped++;
        if (this.opts.showUnsupportedMarkers) this.drawUnsupportedMarker(entity);
    }
  }

  private beginStyledPath(entity: CadEntity, fill = false): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const color = resolveCadColor(entity, this.document, { foreground: this.opts.foreground, background: this.opts.background, trueColorByteOrder: this.opts.trueColorByteOrder, contrastMode: this.opts.contrastMode, minColorContrast: this.opts.minColorContrast });
    const fillColor = resolveFillColor(entity, this.document, { foreground: this.opts.foreground, background: this.opts.background, trueColorByteOrder: this.opts.trueColorByteOrder, contrastMode: this.opts.contrastMode, minColorContrast: this.opts.minColorContrast }) ?? color;
    ctx.strokeStyle = color;
    ctx.fillStyle = fill ? fillColor : color;
    ctx.globalAlpha = clamp(Number(entity.opacity ?? 1), 0, 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const lw = typeof entity.lineweight === 'number' && entity.lineweight > 0 ? entity.lineweight : 0;
    ctx.lineWidth = Math.max(1, Math.min(12, lw > 0 ? lw / 30 : 1));
    ctx.beginPath();
  }

  private finishStroke(): void { this.ctx.stroke(); this.ctx.restore(); this.stats.drawn++; }
  private finishFillStroke(fill = false): void { if (fill) this.ctx.fill(); this.ctx.stroke(); this.ctx.restore(); this.stats.drawn++; }

  private drawLine(e: CadEntity): void {
    const start = e.startPoint;
    const end = e.endPoint;
    if (!isFinitePoint(start) || !isFinitePoint(end)) return this.markSkipped('LINE');
    const a = this.worldToScreen(start);
    const b = this.worldToScreen(end);
    this.beginStyledPath(e);
    this.ctx.moveTo(a.x, a.y);
    this.ctx.lineTo(b.x, b.y);
    this.finishStroke();
  }

  private drawCircle(e: CadEntity): void {
    const center = e.center;
    const radius = Number(e.radius);
    if (!isFinitePoint(center) || !Number.isFinite(radius)) return this.markSkipped('CIRCLE');
    const c = this.worldToScreen(center);
    this.beginStyledPath(e);
    this.ctx.arc(c.x, c.y, Math.abs(radius) * this.view.scale, 0, Math.PI * 2);
    this.finishStroke();
  }

  private drawArc(e: CadEntity): void {
    const center = e.center;
    const radius = Number(e.radius);
    const startAngle = Number(e.startAngle);
    const endAngle = Number(e.endAngle);
    if (!isFinitePoint(center) || !Number.isFinite(radius) || !Number.isFinite(startAngle) || !Number.isFinite(endAngle)) return this.markSkipped('ARC');
    this.strokeWorldPolyline(e, arcPoints(xy(center), radius, startAngle, endAngle, true), false);
  }

  private drawPolyline(e: CadEntity): void {
    const vertices = (e.vertices ?? e.points) as Array<CadPoint3D & { bulge?: number }> | undefined;
    if (!Array.isArray(vertices) || vertices.length < 2) return this.markSkipped(String(e.type));
    const closed = Boolean(e.isClosed) || (Number(e.flag) & 1) === 1;
    const pts: CadPoint2D[] = [];
    const pairs = closed ? vertices.length : vertices.length - 1;
    for (let i = 0; i < pairs; i++) {
      const p1 = vertices[i];
      const p2 = vertices[(i + 1) % vertices.length];
      if (!isFinitePoint(p1) || !isFinitePoint(p2)) continue;
      const segment = bulgeToPolylinePoints(p1, p2, Number(p1.bulge ?? 0));
      if (pts.length > 0) segment.shift();
      pts.push(...segment);
    }
    this.strokeWorldPolyline(e, pts, closed);
  }

  private drawEllipse(e: CadEntity): void {
    const center = e.center;
    const major = e.majorAxisEndPoint;
    const ratio = Number(e.axisRatio ?? 1);
    if (!isFinitePoint(center) || !isFinitePoint(major)) return this.markSkipped('ELLIPSE');
    const pts = ellipsePoints(center, major, ratio, Number(e.startAngle ?? 0), Number(e.endAngle ?? Math.PI * 2));
    const closed = Math.abs(Number(e.endAngle ?? Math.PI * 2) - Number(e.startAngle ?? 0)) >= Math.PI * 2 - 1e-6;
    this.strokeWorldPolyline(e, pts, closed);
  }

  private drawPoint(e: CadEntity): void {
    const p = (e.point ?? e.location ?? e.center ?? e.insertionPoint) as CadPoint3D | undefined;
    if (!isFinitePoint(p)) return this.markSkipped('POINT');
    const s = this.worldToScreen(p);
    this.beginStyledPath(e);
    this.ctx.moveTo(s.x - 3, s.y);
    this.ctx.lineTo(s.x + 3, s.y);
    this.ctx.moveTo(s.x, s.y - 3);
    this.ctx.lineTo(s.x, s.y + 3);
    this.finishStroke();
  }

  private drawText(e: CadEntity): void {
    const p = (e.insertionPoint ?? e.startPoint ?? e.center) as CadPoint3D | undefined;
    const text = stripMTextFormatting(String(e.text ?? e.value ?? ''));
    const height = Number(e.textHeight ?? e.height ?? 1);
    if (!isFinitePoint(p) || !text) return this.markSkipped(String(e.type));
    this.drawTextAt(e, p, text, height, Number(e.rotation ?? 0));
  }

  private drawInsert(e: CadEntity, depth: number): void {
    const block = this.lookupBlock(e.blockName ?? e.name);
    if (block && depth < this.opts.maxInsertDepth) {
      const matrix = matrixFromInsert(e, block.basePoint ?? { x: 0, y: 0 });
      for (const child of block.entities) {
        const inherited = applyByBlockColorInheritance(child, e, this.document, { foreground: this.opts.foreground, background: this.opts.background, trueColorByteOrder: this.opts.trueColorByteOrder, contrastMode: this.opts.contrastMode, minColorContrast: this.opts.minColorContrast });
        this.drawEntityTracked(transformEntity(inherited, matrix), depth + 1);
      }
      return;
    }
    const p = e.insertionPoint;
    if (!isFinitePoint(p)) return this.markSkipped('INSERT');
    const s = this.worldToScreen(p);
    this.beginStyledPath(e);
    const r = 5;
    this.ctx.rect(s.x - r, s.y - r, r * 2, r * 2);
    this.finishStroke();
    if (Array.isArray(e.attribs)) for (const attr of e.attribs) this.drawText(attr);
  }

  private drawSolid(e: CadEntity): void {
    const vertices = (e.vertices ?? e.points) as CadPoint3D[] | undefined;
    if (!Array.isArray(vertices) || vertices.length < 3) return this.markSkipped(String(e.type));
    this.beginStyledPath(e, true);
    const first = this.worldToScreen(vertices[0]);
    this.ctx.moveTo(first.x, first.y);
    for (const vertex of vertices.slice(1)) {
      if (!isFinitePoint(vertex)) continue;
      const s = this.worldToScreen(vertex);
      this.ctx.lineTo(s.x, s.y);
    }
    this.ctx.closePath();
    this.finishFillStroke(true);
  }

  private drawHatch(e: CadEntity): void {
    const loops = e.loops;
    if (!Array.isArray(loops) || loops.length === 0) return this.markSkipped('HATCH');
    this.beginStyledPath(e, true);
    for (const loop of loops) {
      if (loop.commands?.length) this.addPathCommands(loop.commands);
      else if (loop.vertices?.length) {
        const first = this.worldToScreen(loop.vertices[0]);
        this.ctx.moveTo(first.x, first.y);
        for (const p of loop.vertices.slice(1)) {
          const s = this.worldToScreen(p);
          this.ctx.lineTo(s.x, s.y);
        }
        this.ctx.closePath();
      }
    }
    this.finishFillStroke(Boolean(resolveFillColor(e, this.document, { foreground: this.opts.foreground, background: this.opts.background, trueColorByteOrder: this.opts.trueColorByteOrder, contrastMode: this.opts.contrastMode, minColorContrast: this.opts.minColorContrast })));
  }

  private drawSpline(e: CadEntity): void {
    const points = e.fitPoints?.length ? e.fitPoints : e.controlPoints;
    if (!points || points.length < 2) return this.markSkipped('SPLINE');
    // Lightweight preview: draw fit/control polygon. A full NURBS evaluator can be added behind this normalized entity.
    this.strokeWorldPolyline(e, points, Boolean(e.isClosed));
  }

  private drawPath(e: CadEntity): void {
    if (!e.commands?.length) return this.markSkipped(String(e.type));
    this.beginStyledPath(e, Boolean(e.fillColor));
    this.addPathCommands(e.commands);
    this.finishFillStroke(Boolean(e.fillColor));
  }

  private addPathCommands(commands: CadPathCommand[]): void {
    for (const command of commands) {
      if (command.cmd === 'M') {
        const p = this.worldToScreen(command.points[0]);
        this.ctx.moveTo(p.x, p.y);
      } else if (command.cmd === 'L') {
        const p = this.worldToScreen(command.points[0]);
        this.ctx.lineTo(p.x, p.y);
      } else if (command.cmd === 'C') {
        const [p1, p2, p3] = command.points.map((p) => this.worldToScreen(p));
        this.ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
      } else if (command.cmd === 'Q') {
        const [p1, p2] = command.points.map((p) => this.worldToScreen(p));
        this.ctx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
      } else if (command.cmd === 'Z') this.ctx.closePath();
    }
  }

  private drawImage(e: CadEntity): void {
    const p = e.insertionPoint;
    if (!isFinitePoint(p)) return this.markSkipped(String(e.type));
    const w = Number(e.width ?? 32);
    const h = Number(e.height ?? 32);
    const a = this.worldToScreen(p);
    const b = this.worldToScreen({ x: p.x + w, y: p.y - h });
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const width = Math.abs(b.x - a.x);
    const height = Math.abs(b.y - a.y);
    const src = e.imageDataUrl;
    if (src) {
      const image = this.getImage(src);
      if (image.complete && image.naturalWidth > 0) {
        this.ctx.save();
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.ctx.drawImage(image, x, y, width, height);
        this.ctx.restore();
        this.stats.drawn++;
        return;
      }
      image.onload = () => this.render();
    }
    if (!this.opts.showImagePlaceholders) return this.markSkipped(String(e.type));
    this.beginStyledPath(e);
    this.ctx.rect(x, y, width, height);
    this.ctx.moveTo(x, y); this.ctx.lineTo(x + width, y + height);
    this.ctx.moveTo(x + width, y); this.ctx.lineTo(x, y + height);
    this.finishStroke();
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

  private drawUnsupportedMarker(e: CadEntity): void {
    const p = this.entityAnchor(e);
    if (!p) return;
    const s = this.worldToScreen(p);
    this.beginStyledPath(e);
    this.ctx.moveTo(s.x - 4, s.y - 4);
    this.ctx.lineTo(s.x + 4, s.y + 4);
    this.ctx.moveTo(s.x + 4, s.y - 4);
    this.ctx.lineTo(s.x - 4, s.y + 4);
    this.finishStroke();
  }

  private drawTextAt(e: CadEntity, p: CadPoint2D, text: string, height: number, rotation: number): void {
    const ctx = this.ctx;
    const s = this.worldToScreen(p);
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(s.x, s.y);
    ctx.rotate(-rotation);
    const pixelHeight = Math.max(4, Math.min(256, Math.abs(height) * this.view.scale));
    ctx.font = `${pixelHeight}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillStyle = resolveCadColor(e, this.document, { foreground: this.opts.foreground, background: this.opts.background, trueColorByteOrder: this.opts.trueColorByteOrder, contrastMode: this.opts.contrastMode, minColorContrast: this.opts.minColorContrast });
    ctx.globalAlpha = clamp(Number(e.opacity ?? 1), 0, 1);
    ctx.textBaseline = 'alphabetic';
    for (const [index, line] of text.split(/\r?\n/g).entries()) ctx.fillText(line, 0, index * pixelHeight * 1.22);
    ctx.restore();
    this.stats.drawn++;
  }

  private strokeWorldPolyline(e: CadEntity, points: CadPoint2D[], closed: boolean): void {
    const valid = points.filter(isFinitePoint);
    if (valid.length < 2) return this.markSkipped(String(e.type));
    this.beginStyledPath(e);
    const first = this.worldToScreen(valid[0]);
    this.ctx.moveTo(first.x, first.y);
    for (const point of valid.slice(1)) {
      const s = this.worldToScreen(point);
      this.ctx.lineTo(s.x, s.y);
    }
    if (closed) this.ctx.closePath();
    this.finishStroke();
  }

  private markSkipped(type: string): void {
    this.stats.skipped++;
    this.stats.unsupported[type] = this.stats.unsupported[type] ?? 0;
  }

  private entityAnchor(e: CadEntity): CadPoint2D | undefined {
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

  private computeBounds(document: CadDocument): CadBounds {
    const bounds = emptyBounds();
    if (document.pages?.length) {
      for (const page of document.pages) {
        includePoint(bounds, { x: 0, y: 0 });
        includePoint(bounds, { x: page.width, y: page.height });
      }
    }
    for (const entity of document.entities) this.includeEntityBounds(bounds, entity, 0);
    return paddedBounds(bounds);
  }

  private includeEntityBounds(bounds: CadBounds, entity: CadEntity, depth: number): void {
    const type = String(entity.type ?? '').toUpperCase();
    const kind = entity.kind ?? inferEntityKind(type);
    if (kind === 'insert') {
      const block = this.lookupBlock(entity.blockName ?? entity.name);
      if (block && depth < this.opts.maxInsertDepth) {
        const matrix = matrixFromInsert(entity, block.basePoint ?? { x: 0, y: 0 });
        for (const child of block.entities) this.includeEntityBounds(bounds, transformEntity(child, matrix), depth + 1);
        return;
      }
    }
    if (kind === 'line') {
      if (isFinitePoint(entity.startPoint)) includePoint(bounds, entity.startPoint);
      if (isFinitePoint(entity.endPoint)) includePoint(bounds, entity.endPoint);
    } else if (kind === 'circle' || kind === 'arc') {
      if (isFinitePoint(entity.center) && Number.isFinite(entity.radius)) includeCircle(bounds, entity.center, Number(entity.radius));
    } else if (kind === 'polyline' || kind === 'solid' || kind === 'spline') {
      for (const p of [...(entity.vertices ?? []), ...(entity.points ?? []), ...(entity.controlPoints ?? []), ...(entity.fitPoints ?? [])]) if (isFinitePoint(p)) includePoint(bounds, p);
    } else if (kind === 'ellipse') {
      if (isFinitePoint(entity.center) && isFinitePoint(entity.majorAxisEndPoint)) ellipsePoints(entity.center, entity.majorAxisEndPoint, Number(entity.axisRatio ?? 1), Number(entity.startAngle ?? 0), Number(entity.endAngle ?? Math.PI * 2)).forEach((p) => includePoint(bounds, p));
    } else if (kind === 'path') {
      for (const command of entity.commands ?? []) for (const p of command.points) includePoint(bounds, p);
    } else if (kind === 'hatch') {
      for (const loop of entity.loops ?? []) {
        for (const p of loop.vertices ?? []) includePoint(bounds, p);
        for (const command of loop.commands ?? []) for (const p of command.points) includePoint(bounds, p);
      }
    } else {
      const anchor = this.entityAnchor(entity);
      if (anchor) includePoint(bounds, anchor);
    }
  }

  private lookupLayer(name: string | undefined) {
    if (!this.document || !name) return undefined;
    return this.document.layers[name] ?? this.document.layers[name.toLowerCase()] ?? Object.values(this.document.layers).find((layer) => layer.name.toLowerCase() === name.toLowerCase());
  }

  private lookupBlock(name: string | undefined): CadBlock | undefined {
    if (!this.document || !name) return undefined;
    return this.document.blocks[name] ?? this.document.blocks[name.toLowerCase()] ?? Object.values(this.document.blocks).find((block) => block.name.toLowerCase() === name.toLowerCase());
  }

  private clampScale(value: number): number {
    return Math.min(this.opts.maxScale, Math.max(this.opts.minScale, value));
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
