import '../src/styles.css';
import './styles.css';
import {
  CadViewer,
  isWebGLAvailable,
  serializeCadBomCsv,
  serializeCadBomJson,
  supportsDwgWorker,
  type CadBom,
  type CadBomSourceKind,
  type CadLoadProgress,
  type CadReferenceState,
  type CadViewerLoadResult,
  type CadViewerRendererBackend,
  type RenderStats,
  type ViewChangeEvent
} from '../src';

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
        <input id="reference-input" class="visually-hidden" type="file" accept=".shx" multiple />
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
        <button id="reference-upload" class="reference-upload is-hidden" type="button" title="Upload missing SHX reference">
          <span>Missing SHX</span>
          <strong id="reference-upload-name">External SHX font</strong>
        </button>
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
        <div class="inspector-section bom-section">
          <div class="inspector-heading">
            <h2>Bill of materials</h2>
            <div class="bom-actions">
              <select id="bom-table-select" class="bom-select is-hidden" aria-label="Table to export as CSV"></select>
              <button id="bom-csv-button" class="mini-btn" type="button" disabled>CSV</button>
              <button id="bom-json-button" class="mini-btn" type="button" disabled>JSON</button>
            </div>
          </div>
          <div id="bom-summary" class="bom-summary muted">No BOM data.</div>
          <div id="bom-list" class="bom-list"></div>
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
const referenceInput = getElement<HTMLInputElement>('reference-input');
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
const referenceUploadButton = getElement<HTMLButtonElement>('reference-upload');
const referenceUploadNameEl = getElement<HTMLElement>('reference-upload-name');

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
const bomSummaryEl = getElement<HTMLElement>('bom-summary');
const bomListEl = getElement<HTMLElement>('bom-list');
const bomTableSelect = getElement<HTMLSelectElement>('bom-table-select');
const bomCsvButton = getElement<HTMLButtonElement>('bom-csv-button');
const bomJsonButton = getElement<HTMLButtonElement>('bom-json-button');
const typeListEl = getElement<HTMLElement>('type-list');
const warningsEl = getElement<HTMLElement>('warnings');
const statusEl = getElement<HTMLElement>('status');
const cursorEl = getElement<HTMLElement>('cursor');

type UiTheme = 'dark' | 'light';
type DrawingTheme = 'dark' | 'light';

const WASM_PATH = new URL('wasm/', document.baseURI).href;
const DEMO_RENDERER = resolveDemoRenderer();

const DRAWING_THEMES: Record<DrawingTheme, { background: string; foreground: string; minContrast: number }> = {
  dark: { background: '#05070d', foreground: '#f8fafc', minContrast: 2.45 },
  light: { background: '#f7f8fb', foreground: '#111827', minContrast: 2.75 }
};

let uiTheme: UiTheme = readStoredTheme('cad-viewer-ui-theme', prefersLight() ? 'light' : 'dark');
let drawingTheme: DrawingTheme = readStoredTheme('cad-viewer-drawing-theme', 'dark');
let adaptiveContrast = localStorage.getItem('cad-viewer-adaptive-contrast') !== 'false';
let activeAbort: AbortController | undefined;
let currentBom: CadBom | undefined;

const viewer = new CadViewer({
  canvas,
  renderer: DEMO_RENDERER,
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
    console.error('[cad-viewer] Failed to load CAD file.', error);
    setStatus(error.message, true);
    setLoading(false);
    if (!viewer.getDocument()) emptyHint.classList.remove('is-hidden');
  },
  onRenderStats: updateRenderStats,
  onViewChange: updateViewInfo,
  onReferenceStateChange: updateReferenceState
});

applyAppearance();

openButton.addEventListener('click', () => fileInput.click());
referenceUploadButton.addEventListener('click', () => referenceInput.click());
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
  currentBom = undefined;
  renderBom();
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

bomCsvButton.addEventListener('click', () => {
  if (!currentBom?.tables.length) return;
  const tableId = bomTableSelect.value || undefined;
  const table = currentBom.tables.find((candidate) => candidate.id === tableId);
  downloadText(
    `${downloadBaseName(currentBom.sourceName)}-${downloadBaseName(table?.name ?? 'bom')}.csv`,
    serializeCadBomCsv(currentBom, { tableId, escapeFormulas: true, includeUtf8Bom: true }),
    'text/csv;charset=utf-8'
  );
});

bomJsonButton.addEventListener('click', () => {
  if (!currentBom) return;
  downloadText(
    `${downloadBaseName(currentBom.sourceName)}-bom.json`,
    serializeCadBomJson(currentBom),
    'application/json;charset=utf-8'
  );
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

referenceInput.addEventListener('change', async () => {
  await addReferenceFiles([...referenceInput.files ?? []]);
  referenceInput.value = '';
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
  const files = [...event.dataTransfer?.files ?? []];
  const references = files.filter((file) => /\.shx$/i.test(file.name));
  if (references.length > 0) await addReferenceFiles(references);
  const drawing = files.find((file) => !/\.shx$/i.test(file.name));
  if (drawing) await loadFile(drawing);
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
  currentBom = viewer.getBom();
  renderBom();

  const entries = Object.entries(result.summary.byType).sort((a, b) => b[1] - a[1]);
  typeListEl.classList.toggle('muted', entries.length === 0);
  typeListEl.innerHTML = entries.length
    ? entries.slice(0, 24).map(([type, count]) => `<span><b>${escapeHtml(type)}</b>${count.toLocaleString()}</span>`).join('')
    : 'No entities.';

  updateWarnings(result.warnings);
  emptyHint.classList.add('is-hidden');
  setLoading(false);
  setStatus(`Loaded ${result.format.toUpperCase()} · ${result.summary.entityCount.toLocaleString()} entities`);
}

function renderBom(): void {
  const tables = currentBom?.tables ?? [];
  const displayTables = [...tables].sort((left, right) => right.rows.length - left.rows.length);
  bomCsvButton.disabled = tables.length === 0;
  bomJsonButton.disabled = !currentBom;
  bomTableSelect.classList.toggle('is-hidden', tables.length < 2);
  bomTableSelect.replaceChildren(...displayTables.map((table) => {
    const option = document.createElement('option');
    option.value = table.id;
    option.textContent = `${table.name} (${table.rows.length.toLocaleString()})`;
    return option;
  }));

  if (!currentBom) {
    bomSummaryEl.textContent = 'No BOM data.';
    bomSummaryEl.className = 'bom-summary muted';
    bomListEl.replaceChildren();
    return;
  }

  const { summary } = currentBom;
  bomSummaryEl.className = 'bom-summary';
  bomSummaryEl.innerHTML = [
    summary.tableCount ? `<span><b>${summary.tableCount.toLocaleString()}</b> tables</span>` : '',
    summary.rowCount ? `<span><b>${summary.rowCount.toLocaleString()}</b> rows</span>` : '',
    summary.blockQuantity ? `<span><b>${summary.blockQuantity.toLocaleString()}</b> quantity</span>` : ''
  ].filter(Boolean).join('') || '<span>No structured BOM rows.</span>';

  const fragment = document.createDocumentFragment();
  for (const [index, table] of displayTables.slice(0, 12).entries()) {
    const details = document.createElement('details');
    details.className = 'bom-table';
    details.open = index === 0;
    details.addEventListener('toggle', () => {
      if (details.open) bomTableSelect.value = table.id;
    });
    details.innerHTML = `
      <summary>
        <span class="bom-table-title"><b>${escapeHtml(table.name)}</b><small>${escapeHtml(sourceLabel(table.source))}</small></span>
        <span class="bom-table-count">${table.rows.length.toLocaleString()} rows</span>
      </summary>
      ${renderBomTablePreview(table)}
    `;
    fragment.append(details);
  }
  if (tables.length > 12) {
    const more = document.createElement('p');
    more.className = 'bom-more muted';
    more.textContent = `${(tables.length - 12).toLocaleString()} more tables are available in the JSON export.`;
    fragment.append(more);
  }
  if (currentBom.warnings.length > 0) {
    const warning = document.createElement('p');
    warning.className = 'bom-note';
    warning.textContent = currentBom.warnings[0]?.message ?? '';
    fragment.append(warning);
  }
  bomListEl.replaceChildren(fragment);
}

function renderBomTablePreview(table: CadBom['tables'][number]): string {
  const columns = table.columns.slice(0, 4);
  const rows = table.rows.slice(0, 5);
  if (columns.length === 0 || rows.length === 0) return '<p class="bom-more muted">No tabular values.</p>';
  return `
    <div class="bom-preview" role="region" aria-label="${escapeHtml(table.name)} preview" tabindex="0">
      <table>
        <thead><tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(formatBomValue(row.cells[column.key]))}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>
  `;
}

function formatBomValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(value);
}

function sourceLabel(source: CadBomSourceKind): string {
  const labels: Record<CadBomSourceKind, string> = {
    'block-attributes': 'Block attributes',
    'native-table': 'CAD table',
    'data-table': 'Data table',
    xdata: 'XDATA',
    xrecord: 'XRECORD',
    'text-table': 'Text grid'
  };
  return labels[source];
}

function downloadText(fileName: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadBaseName(value: string | undefined): string {
  const base = (value ?? 'drawing').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 96);
  return base || 'drawing';
}

async function addReferenceFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  referenceUploadButton.disabled = true;
  try {
    for (const file of files) {
      setStatus(`Loading reference ${file.name}…`);
      await viewer.addReferenceFile(file);
    }
    const missing = viewer.getMissingReferences();
    const loadedNames = files.map((file) => file.name).join(', ');
    setStatus(missing.length === 0
      ? `Loaded SHX reference${files.length === 1 ? '' : 's'} · preview completed`
      : `Loaded ${loadedNames} · still missing ${missing.map(({ fileName }) => fileName).join(', ')}`,
    missing.some(({ reason }) => reason === 'incompatible'));
    updateWarnings(viewer.getLoadResult()?.warnings ?? []);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    referenceUploadButton.disabled = false;
  }
}

function updateReferenceState(state: CadReferenceState): void {
  const missing = state.missing;
  referenceUploadButton.classList.toggle('is-hidden', missing.length === 0);
  if (missing.length === 0) return;
  const names = missing.map(({ fileName }) => fileName).join(', ');
  referenceUploadNameEl.textContent = names;
  referenceUploadButton.title = missing.some(({ reason }) => reason === 'incompatible')
    ? `Upload a compatible SHX file for ${names}`
    : `Upload missing SHX reference: ${names}`;
  referenceUploadButton.setAttribute('aria-label', referenceUploadButton.title);
}

function updateWarnings(warnings: string[]): void {
  warningsEl.classList.toggle('muted', warnings.length === 0);
  warningsEl.innerHTML = warnings.length ? warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join('') : '—';
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
  referenceUploadButton.disabled = active;
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

function resolveDemoRenderer(): CadViewerRendererBackend {
  const value = new URLSearchParams(window.location.search).get('renderer');
  return value === 'canvas2d' || value === 'webgl' ? value : 'auto';
}
