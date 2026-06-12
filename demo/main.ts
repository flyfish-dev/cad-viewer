import '../src/styles.css';
import './styles.css';
import { CadViewer, isWebGLAvailable, supportsDwgWorker, type CadLoadProgress, type CadViewerLoadResult, type RenderStats, type ViewChangeEvent } from '../src';

const host = document.querySelector<HTMLDivElement>('#app');
if (!host) throw new Error('#app not found');

host.innerHTML = `
  <main id="cad-app" class="cad-app" data-ui-theme="dark" data-drawing-theme="dark">
    <header class="topbar">
      <div class="brand" aria-label="Lightweight CAD Viewer">
        <span class="brand-mark">CV</span>
        <span class="brand-text">Lightweight CAD Viewer</span>
      </div>

      <div class="toolbar" role="toolbar" aria-label="Viewer controls">
        <input id="file-input" class="visually-hidden" type="file" accept=".dwg,.dxf,.dwf,.dwfx,.xps" />
        <button id="open-button" class="btn btn-primary">Open</button>
        <span class="toolbar-divider"></span>
        <button id="fit-button" class="btn">Fit</button>
        <button id="zoom-out-button" class="btn btn-square" title="Zoom out">−</button>
        <span id="zoom" class="toolbar-value">100%</span>
        <button id="zoom-in-button" class="btn btn-square" title="Zoom in">+</button>
        <span class="toolbar-divider"></span>
        <button id="ui-theme-button" class="btn">UI Dark</button>
        <button id="drawing-theme-button" class="btn">Canvas Dark</button>
        <button id="contrast-button" class="btn is-active">Adaptive Contrast</button>
        <button id="cancel-button" class="btn btn-danger is-hidden">Cancel</button>
        <button id="clear-button" class="btn btn-ghost">Clear</button>
      </div>
    </header>

    <section class="status-strip" aria-label="Viewer status">
      <span class="status-item strong" id="file-name">No file loaded</span>
      <span class="status-item">Format <b id="format">—</b></span>
      <span class="status-item">Entities <b id="entities">0</b></span>
      <span class="status-item">Drawn <b id="drawn">0</b></span>
      <span class="status-item">Skipped <b id="skipped">0</b></span>
      <span class="status-item">Parse <b id="parse-time">—</b></span>
      <span class="status-item">Render <b id="render-time">—</b></span>
      <span class="status-item">Renderer <b id="renderer-backend">${isWebGLAvailable() ? 'WebGL' : 'Canvas2D'}</b></span>
      <span class="status-item">Visible <b id="visible-primitives">—</b></span>
      <span class="status-item">GPU <b id="gpu-memory">—</b></span>
      <span class="status-item">Mode <b id="load-mode">${supportsDwgWorker() ? 'Worker' : 'Main'}</b></span>
      <span class="status-spacer"></span>
      <span id="status" class="status-message">Ready</span>
    </section>

    <section class="workspace">
      <section id="drop-zone" class="canvas-card" aria-label="CAD canvas drop zone">
        <canvas id="cad-canvas" aria-label="CAD preview canvas"></canvas>
        <div id="empty-hint" class="empty-hint">
          <strong>Drop or open DWG / DXF / DWF / DWFx</strong>
          <span>Local parsing, WebGL rendering, worker-backed DWG and native DWF/W2D/W3D preview.</span>
        </div>
        <div id="load-overlay" class="load-overlay is-hidden" aria-live="polite">
          <div class="load-card">
            <div class="load-card-head">
              <strong id="load-title">Loading CAD file</strong>
              <span id="load-percent">0%</span>
            </div>
            <div id="load-detail" class="load-detail">Preparing worker…</div>
            <div class="progress-track"><span id="load-progress" style="width: 0%"></span></div>
          </div>
        </div>
        <div class="canvas-hud">
          <span id="cursor">x: —, y: —</span>
          <span>Wheel zoom · Drag pan</span>
        </div>
      </section>

      <aside class="inspector" aria-label="Drawing details">
        <div class="inspector-section compact-grid">
          <div><dt>File</dt><dd id="file-name-detail">—</dd></div>
          <div><dt>Format</dt><dd id="format-detail">—</dd></div>
          <div><dt>Layers</dt><dd id="layers">0</dd></div>
          <div><dt>Blocks</dt><dd id="blocks">0</dd></div>
        </div>
        <div class="inspector-section">
          <h2>Entity types</h2>
          <div id="type-list" class="type-list muted">No entities.</div>
        </div>
        <div class="inspector-section warnings-section">
          <h2>Warnings</h2>
          <div id="warnings" class="warnings muted">—</div>
        </div>
      </aside>
    </section>
  </main>
`;

const app = getElement<HTMLElement>('cad-app');

const fileInput = getElement<HTMLInputElement>('file-input');
const openButton = getElement<HTMLButtonElement>('open-button');
const fitButton = getElement<HTMLButtonElement>('fit-button');
const zoomInButton = getElement<HTMLButtonElement>('zoom-in-button');
const zoomOutButton = getElement<HTMLButtonElement>('zoom-out-button');
const clearButton = getElement<HTMLButtonElement>('clear-button');
const uiThemeButton = getElement<HTMLButtonElement>('ui-theme-button');
const drawingThemeButton = getElement<HTMLButtonElement>('drawing-theme-button');
const contrastButton = getElement<HTMLButtonElement>('contrast-button');
const cancelButton = getElement<HTMLButtonElement>('cancel-button');
const dropZone = getElement<HTMLElement>('drop-zone');
const emptyHint = getElement<HTMLElement>('empty-hint');
const loadOverlay = getElement<HTMLElement>('load-overlay');
const loadTitleEl = getElement<HTMLElement>('load-title');
const loadDetailEl = getElement<HTMLElement>('load-detail');
const loadPercentEl = getElement<HTMLElement>('load-percent');
const loadProgressEl = getElement<HTMLElement>('load-progress');
const canvas = getElement<HTMLCanvasElement>('cad-canvas');

const fileNameEl = getElement<HTMLElement>('file-name');
const fileNameDetailEl = getElement<HTMLElement>('file-name-detail');
const formatEl = getElement<HTMLElement>('format');
const formatDetailEl = getElement<HTMLElement>('format-detail');
const zoomEl = getElement<HTMLElement>('zoom');
const entitiesEl = getElement<HTMLElement>('entities');
const drawnEl = getElement<HTMLElement>('drawn');
const skippedEl = getElement<HTMLElement>('skipped');
const parseTimeEl = getElement<HTMLElement>('parse-time');
const renderTimeEl = getElement<HTMLElement>('render-time');
const loadModeEl = getElement<HTMLElement>('load-mode');
const rendererBackendEl = getElement<HTMLElement>('renderer-backend');
const visiblePrimitivesEl = getElement<HTMLElement>('visible-primitives');
const gpuMemoryEl = getElement<HTMLElement>('gpu-memory');
const layersEl = getElement<HTMLElement>('layers');
const blocksEl = getElement<HTMLElement>('blocks');
const typeListEl = getElement<HTMLElement>('type-list');
const warningsEl = getElement<HTMLElement>('warnings');
const statusEl = getElement<HTMLElement>('status');
const cursorEl = getElement<HTMLElement>('cursor');

type UiTheme = 'dark' | 'light';
type DrawingTheme = 'dark' | 'light';

const WASM_PATH = new URL('wasm/', document.baseURI).href;

const DRAWING_THEMES: Record<DrawingTheme, { background: string; foreground: string; minContrast: number }> = {
  dark: { background: '#05070d', foreground: '#f8fafc', minContrast: 2.45 },
  light: { background: '#f7f8fb', foreground: '#111827', minContrast: 2.75 }
};

let uiTheme: UiTheme = readStoredTheme('cad-viewer-ui-theme', prefersLight() ? 'light' : 'dark');
let drawingTheme: DrawingTheme = readStoredTheme('cad-viewer-drawing-theme', 'dark');
let adaptiveContrast = localStorage.getItem('cad-viewer-adaptive-contrast') !== 'false';
let activeAbort: AbortController | undefined;

const viewer = new CadViewer({
  canvas,
  renderer: 'auto',
  wasmPath: WASM_PATH,
  canvasOptions: {
    background: DRAWING_THEMES[drawingTheme].background,
    foreground: DRAWING_THEMES[drawingTheme].foreground,
    showUnsupportedMarkers: false,
    showPageBounds: true,
    contrastMode: adaptiveContrast ? 'adaptive' : 'preserve',
    minColorContrast: DRAWING_THEMES[drawingTheme].minContrast,
    enableSpatialIndex: true,
    spatialIndexCellCount: 96,
    maxVerticesPerBatch: 32768,
    maxCurveSegments: 72,
    textMinPixelHeight: 4,
    maxVisibleTextLabels: 2400,
    powerPreference: 'high-performance',
    antialias: true,
    preserveDrawingBuffer: false
  },
  onLoadStart: (source) => {
    setStatus(`Loading ${source instanceof File ? source.name : 'CAD data'}…`);
    emptyHint.classList.add('is-hidden');
    setLoading(true, 'Loading CAD file', 'Reading file bytes…', 2);
  },
  onLoadProgress: updateLoadProgress,
  onLoad: updateLoadInfo,
  onError: (error) => {
    setStatus(error.message, true);
    setLoading(false);
    if (!viewer.getDocument()) emptyHint.classList.remove('is-hidden');
  },
  onRenderStats: updateRenderStats,
  onViewChange: updateViewInfo
});

applyAppearance();

openButton.addEventListener('click', () => fileInput.click());
fitButton.addEventListener('click', () => viewer.fit());
zoomInButton.addEventListener('click', () => viewer.zoomIn());
zoomOutButton.addEventListener('click', () => viewer.zoomOut());

uiThemeButton.addEventListener('click', () => {
  uiTheme = uiTheme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('cad-viewer-ui-theme', uiTheme);
  applyAppearance();
});

drawingThemeButton.addEventListener('click', () => {
  drawingTheme = drawingTheme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('cad-viewer-drawing-theme', drawingTheme);
  applyAppearance();
});

contrastButton.addEventListener('click', () => {
  adaptiveContrast = !adaptiveContrast;
  localStorage.setItem('cad-viewer-adaptive-contrast', String(adaptiveContrast));
  applyAppearance();
});

clearButton.addEventListener('click', () => {
  viewer.clear();
  fileNameEl.textContent = 'No file loaded';
  fileNameDetailEl.textContent = '—';
  formatEl.textContent = '—';
  formatDetailEl.textContent = '—';
  entitiesEl.textContent = '0';
  drawnEl.textContent = '0';
  skippedEl.textContent = '0';
  layersEl.textContent = '0';
  blocksEl.textContent = '0';
  parseTimeEl.textContent = '—';
  renderTimeEl.textContent = '—';
  loadModeEl.textContent = supportsDwgWorker() ? 'Worker' : 'Main';
  rendererBackendEl.textContent = isWebGLAvailable() ? 'WebGL' : 'Canvas2D';
  visiblePrimitivesEl.textContent = '—';
  gpuMemoryEl.textContent = '—';
  typeListEl.textContent = 'No entities.';
  typeListEl.classList.add('muted');
  warningsEl.textContent = '—';
  warningsEl.classList.add('muted');
  emptyHint.classList.remove('is-hidden');
  setStatus('Ready');
});

cancelButton.addEventListener('click', () => {
  activeAbort?.abort();
  setStatus('Loading cancelled');
  setLoading(false);
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (file) await loadFile(file);
  fileInput.value = '';
});

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('is-over');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-over');
  });
}
dropZone.addEventListener('drop', async (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) await loadFile(file);
});

canvas.addEventListener('mousemove', (event) => {
  const point = viewer.renderer.screenToWorld({ x: event.offsetX, y: event.offsetY });
  cursorEl.textContent = `x: ${formatNumber(point.x)}, y: ${formatNumber(point.y)}`;
});

async function loadFile(file: File): Promise<void> {
  activeAbort?.abort();
  activeAbort = new AbortController();
  try {
    setStatus(`Loading ${file.name}…`);
    emptyHint.classList.add('is-hidden');
    await viewer.loadFile(file, { signal: activeAbort.signal, useWorker: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    setStatus(aborted ? 'Loading cancelled' : message, !aborted);
    if (!viewer.getDocument()) emptyHint.classList.remove('is-hidden');
  } finally {
    activeAbort = undefined;
    setLoading(false);
  }
}

function updateLoadInfo(result: CadViewerLoadResult): void {
  const fileName = result.fileName ?? result.document.sourceName ?? 'buffer';
  fileNameEl.textContent = fileName;
  fileNameEl.title = fileName;
  fileNameDetailEl.textContent = fileName;
  fileNameDetailEl.title = fileName;
  formatEl.textContent = result.format.toUpperCase();
  formatDetailEl.textContent = result.format.toUpperCase();
  parseTimeEl.textContent = `${result.elapsedMs.toFixed(1)} ms`;
  loadModeEl.textContent = String(result.document.metadata.loaderMode ?? (result.format === 'dwg' && supportsDwgWorker() ? 'Worker' : 'Main'));
  entitiesEl.textContent = result.summary.entityCount.toLocaleString();
  layersEl.textContent = result.summary.layerCount.toLocaleString();
  blocksEl.textContent = result.summary.blockCount.toLocaleString();

  const entries = Object.entries(result.summary.byType).sort((a, b) => b[1] - a[1]);
  typeListEl.classList.toggle('muted', entries.length === 0);
  typeListEl.innerHTML = entries.length
    ? entries.slice(0, 24).map(([type, count]) => `<span><b>${escapeHtml(type)}</b>${count.toLocaleString()}</span>`).join('')
    : 'No entities.';

  warningsEl.classList.toggle('muted', result.warnings.length === 0);
  warningsEl.innerHTML = result.warnings.length ? result.warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join('') : '—';
  emptyHint.classList.add('is-hidden');
  setLoading(false);
  setStatus(`Loaded ${result.format.toUpperCase()} · ${result.summary.entityCount.toLocaleString()} entities`);
}

function updateRenderStats(stats: RenderStats): void {
  drawnEl.textContent = stats.drawn.toLocaleString();
  skippedEl.textContent = stats.skipped.toLocaleString();
  renderTimeEl.textContent = `${stats.renderElapsedMs.toFixed(1)} ms`;
  rendererBackendEl.textContent = stats.backend === 'webgl' ? 'WebGL' : 'Canvas2D';
  visiblePrimitivesEl.textContent = typeof stats.visiblePrimitiveCount === 'number' ? compactNumber(stats.visiblePrimitiveCount) : '—';
  gpuMemoryEl.textContent = typeof stats.gpuMemoryBytes === 'number' ? formatBytes(stats.gpuMemoryBytes) : '—';
}

function updateViewInfo(event: ViewChangeEvent): void {
  zoomEl.textContent = `${event.zoomPercent.toFixed(0)}%`;
}

function updateLoadProgress(progress: CadLoadProgress): void {
  const title = progress.format ? `${progress.format.toUpperCase()} loading` : 'CAD loading';
  const percent = Number.isFinite(progress.percent) ? Number(progress.percent) : progressPercentFromPhase(progress.phase);
  setLoading(true, title, progress.message, percent);
  setStatus(progress.message);
}

function progressPercentFromPhase(phase: CadLoadProgress['phase']): number {
  switch (phase) {
    case 'read': return 3;
    case 'detect': return 9;
    case 'worker-start': return 14;
    case 'worker-ready': return 20;
    case 'wasm-init': return 31;
    case 'parse': return 55;
    case 'normalize': return 78;
    case 'render': return 94;
    case 'native-render': return 32;
    case 'done': return 100;
    default: return 8;
  }
}

function setLoading(active: boolean, title = 'Loading CAD file', detail = 'Preparing…', percent = 0): void {
  loadOverlay.classList.toggle('is-hidden', !active);
  cancelButton.classList.toggle('is-hidden', !active);
  openButton.disabled = active;
  clearButton.disabled = active;
  loadTitleEl.textContent = title;
  loadDetailEl.textContent = detail;
  const clamped = Math.max(0, Math.min(100, percent));
  loadPercentEl.textContent = `${Math.round(clamped)}%`;
  loadProgressEl.style.width = `${clamped}%`;
}

function applyAppearance(): void {
  const drawing = DRAWING_THEMES[drawingTheme];
  app.dataset.uiTheme = uiTheme;
  app.dataset.drawingTheme = drawingTheme;
  document.documentElement.dataset.uiTheme = uiTheme;
  document.documentElement.style.colorScheme = uiTheme;
  uiThemeButton.textContent = `UI ${capitalize(uiTheme)}`;
  drawingThemeButton.textContent = `Canvas ${capitalize(drawingTheme)}`;
  contrastButton.textContent = adaptiveContrast ? 'Adaptive Contrast' : 'Preserve Colors';
  contrastButton.classList.toggle('is-active', adaptiveContrast);
  viewer.setCanvasOptions({
    background: drawing.background,
    foreground: drawing.foreground,
    contrastMode: adaptiveContrast ? 'adaptive' : 'preserve',
    minColorContrast: drawing.minContrast
  });
}

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('is-error', isError);
}

function getElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

function formatNumber(value: number): string {
  if (Math.abs(value) >= 1000 || (Math.abs(value) < 0.01 && value !== 0)) return value.toExponential(2);
  return value.toFixed(2);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[char] ?? char);
}

function readStoredTheme<T extends 'dark' | 'light'>(key: string, fallback: T): T {
  const value = localStorage.getItem(key);
  return value === 'dark' || value === 'light' ? value as T : fallback;
}

function prefersLight(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1_000).toFixed(0)}k`;
  return value.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
