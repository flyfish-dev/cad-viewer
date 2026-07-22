export type CadFormat = 'dwg' | 'dxf' | 'dwf' | 'dwfx' | 'xps' | 'unknown';
export type CadDwfLineWeightMode = 'adaptive' | 'physical' | 'hairline';

export interface CadPoint2D {
  x: number;
  y: number;
}

export interface CadPoint3D extends CadPoint2D {
  z?: number;
}

export type CadPoint = CadPoint2D | CadPoint3D;

export type CadDataScalar = string | number | boolean | null;
export type CadDataValue = CadDataScalar | CadPoint3D | CadDataValue[] | { [key: string]: CadDataValue };

export interface CadXDataEntry {
  code?: number;
  name?: string;
  value: CadDataValue;
}

/** Application-owned extended entity data (XDATA), normalized for workers and JSON export. */
export interface CadXData {
  appName?: string;
  entries: CadXDataEntry[];
}

export interface CadTableCell {
  row: number;
  column: number;
  text: string;
  value?: CadDataValue;
  dataType?: string | number;
  formula?: string;
  rowSpan?: number;
  columnSpan?: number;
  isMerged?: boolean;
  textHeight?: number;
  blockTableRecordId?: string;
  blockAttributes?: Record<string, string>;
}

/** Native ACAD_TABLE data retained independently from its render geometry. */
export interface CadTableData {
  name?: string;
  rowCount: number;
  columnCount: number;
  cells: CadTableCell[];
  rowHeights?: number[];
  columnWidths?: number[];
  dataLinkHandle?: string;
  titleSuppressed?: boolean;
  headerSuppressed?: boolean;
}

export interface CadDataLink {
  handle?: string;
  dataAdapter?: string;
  description?: string;
  tooltip?: string;
  connectionString?: string;
  updateStatus?: string;
  updateOption?: number;
  pathOption?: number;
  lastUpdated?: string;
}

export interface CadDataTableColumn {
  name: string;
  type?: number | string;
  values: CadDataValue[];
}

export interface CadDataTable {
  handle?: string;
  name?: string;
  rowCount: number;
  columnCount: number;
  columns: CadDataTableColumn[];
}

export interface CadXRecordGroup {
  code?: number;
  value: CadDataValue;
}

export interface CadXRecord {
  handle?: string;
  ownerHandle?: string;
  entryName?: string;
  dictionaryPath?: string[];
  extensionDictionary?: string;
  cloning?: number;
  data: CadXRecordGroup[];
}

export interface CadDictionaryEntry {
  name: string;
  handle: string;
}

export interface CadDictionary {
  handle?: string;
  ownerHandle?: string;
  entries: CadDictionaryEntry[];
}

export interface CadBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type CadFitMode = 'auto' | 'saved-view' | 'extents';

export interface CadLayer {
  name: string;
  color?: string | number;
  colorIndex?: number;
  trueColor?: number;
  lineType?: string;
  lineweight?: number;
  isVisible?: boolean;
  isLocked?: boolean;
  isFrozen?: boolean;
  raw?: unknown;
}

export interface CadLineTypeElement {
  /** Signed AutoCAD pattern length: positive=dash, negative=gap, zero=dot/shape. */
  length: number;
  elementTypeFlag?: number;
  shapeNumber?: number;
  scale?: number;
  rotation?: number;
  offsetX?: number;
  offsetY?: number;
  text?: string;
  /** STYLE table handle referenced by DXF group 340 / the DWG LTYPE dash. */
  styleHandle?: string;
  /** Resolved SHX file name from the referenced STYLE table entry. */
  fontName?: string;
}

export interface CadLineType {
  name: string;
  handle?: string;
  description?: string;
  totalPatternLength?: number;
  pattern: CadLineTypeElement[];
  raw?: unknown;
}

export interface CadSceneTransform2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface CadSavedView {
  source: 'vport' | 'header-ucs';
  name?: string;
  handle?: string;
  center?: CadPoint2D;
  target?: CadPoint3D;
  direction?: CadPoint3D;
  viewHeight?: number;
  aspectRatio?: number;
  twistAngle: number;
  ucsOrigin?: CadPoint3D;
  ucsXAxis?: CadPoint3D;
  ucsYAxis?: CadPoint3D;
  sceneTransformApplied: boolean;
  /** WCS-to-normalized-scene transform used by render, bounds and interaction. */
  sceneTransform: CadSceneTransform2D;
}

export interface CadPathCommand {
  cmd: 'M' | 'L' | 'C' | 'Q' | 'Z';
  points: CadPoint2D[];
}

export type CadEntityKind =
  | 'line'
  | 'circle'
  | 'arc'
  | 'polyline'
  | 'ellipse'
  | 'text'
  | 'point'
  | 'insert'
  | 'solid'
  | 'hatch'
  | 'spline'
  | 'path'
  | 'image'
  | 'viewport'
  | 'table'
  | 'unsupported';

export interface CadEntity {
  id?: string;
  type: string;
  kind?: CadEntityKind;
  handle?: string;
  layer?: string;
  color?: string | number;
  trueColor?: number | string | { r: number; g: number; b: number; a?: number };
  colorIndex?: number;
  colorNumber?: number;
  colorName?: string;
  fillColor?: string | number;
  fillColorIndex?: number;
  opacity?: number;
  lineweight?: number;
  lineType?: string;
  linetype?: string;
  lineTypeScale?: number;
  isVisible?: boolean;
  isInPaperSpace?: boolean;

  startPoint?: CadPoint3D;
  endPoint?: CadPoint3D;
  center?: CadPoint3D;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  majorAxisEndPoint?: CadPoint3D;
  axisRatio?: number;
  vertices?: Array<CadPoint3D & { bulge?: number; startWidth?: number; endWidth?: number }>;
  points?: CadPoint3D[];
  controlPoints?: CadPoint3D[];
  fitPoints?: CadPoint3D[];
  degree?: number;
  knots?: number[];
  isClosed?: boolean;
  flag?: number;
  /** Constant polyline width in drawing units. */
  constantWidth?: number;
  thickness?: number;

  insertionPoint?: CadPoint3D;
  text?: string;
  value?: string;
  height?: number;
  textHeight?: number;
  /** TEXT width factor, where 1 is the authored glyph width. */
  xScale?: number;
  generationFlag?: number;
  halign?: number;
  valign?: number;
  extrusionDirection?: CadPoint3D;
  rotation?: number;
  scale?: CadPoint3D;
  name?: string;
  blockName?: string;
  /** Dynamic-block display name when it differs from the anonymous block record name. */
  effectiveBlockName?: string;
  extensionDictionaryHandle?: string;
  ownerBlockRecordHandle?: string;
  /** ATTRIB/ATTDEF tag. Attribute tags are compared case-insensitively by BOM extraction. */
  attributeTag?: string;
  /** ATTDEF prompt, retained for column labels and diagnostics. */
  attributePrompt?: string;
  attributeFlags?: number;
  insertRowCount?: number;
  insertColumnCount?: number;
  insertRowSpacing?: number;
  insertColumnSpacing?: number;
  attribs?: CadEntity[];
  xdata?: CadXData[];
  table?: CadTableData;

  loops?: Array<{ vertices?: CadPoint3D[]; commands?: CadPathCommand[]; isClosed?: boolean }>;
  commands?: CadPathCommand[];
  imageSource?: string;
  imageDataUrl?: string;
  width?: number;
  pageIndex?: number;

  raw?: unknown;
  [key: string]: unknown;
}

export interface CadBlock {
  name: string;
  basePoint?: CadPoint3D;
  entities: CadEntity[];
  raw?: unknown;
}

export interface CadPage {
  index: number;
  name?: string;
  width: number;
  height: number;
  entities: CadEntity[];
}

export interface CadDocument {
  format: CadFormat;
  sourceName?: string;
  units?: string;
  header?: Record<string, unknown>;
  layers: Record<string, CadLayer>;
  lineTypes?: Record<string, CadLineType>;
  blocks: Record<string, CadBlock>;
  entities: CadEntity[];
  pages?: CadPage[];
  savedView?: CadSavedView;
  dataLinks?: CadDataLink[];
  dataTables?: CadDataTable[];
  xrecords?: CadXRecord[];
  dictionaries?: CadDictionary[];
  metadata: Record<string, unknown>;
  warnings: string[];
  raw?: unknown;
}

export type CadBomSourceKind =
  | 'block-attributes'
  | 'native-table'
  | 'data-table'
  | 'xdata'
  | 'xrecord'
  | 'text-table';

export type CadBomWarningCode =
  | 'unsupported-format'
  | 'missing-block'
  | 'cyclic-block'
  | 'max-depth'
  | 'max-entities'
  | 'max-rows'
  | 'max-cells'
  | 'invalid-table-cell'
  | 'duplicate-attribute'
  | 'empty-native-table'
  | 'external-data-unavailable'
  | 'low-confidence-text-table';

export interface CadBomWarning {
  code: CadBomWarningCode;
  message: string;
  source?: CadBomSourceKind;
  handle?: string;
  blockName?: string;
}

export interface CadBomColumn {
  key: string;
  label: string;
  dataType: 'string' | 'number' | 'boolean' | 'mixed';
  sourceKey?: string;
}

export interface CadBomRow {
  id: string;
  cells: Record<string, CadDataScalar>;
  quantity?: number;
  sourceHandles?: string[];
  blockName?: string;
  effectiveBlockName?: string;
  layer?: string;
}

export interface CadBomTable {
  id: string;
  name: string;
  source: CadBomSourceKind;
  confidence: number;
  columns: CadBomColumn[];
  rows: CadBomRow[];
  handle?: string;
  dataLink?: CadDataLink;
  warnings: CadBomWarning[];
}

export interface CadBomSummary {
  tableCount: number;
  rowCount: number;
  sourceCounts: Partial<Record<CadBomSourceKind, number>>;
  blockItemCount: number;
  blockQuantity: number;
}

export interface CadBom {
  schemaVersion: 1;
  sourceName?: string;
  format: CadFormat;
  tables: CadBomTable[];
  summary: CadBomSummary;
  warnings: CadBomWarning[];
}

export interface CadBomOptions {
  /** Sources enabled for extraction. Arbitrary application XDATA/XRECORD data is opt-in; common BOM sources are enabled by default. */
  sources?: CadBomSourceKind[];
  /** Reconstruct aligned TEXT/MTEXT as a table. `auto` only accepts high-confidence grids. */
  textTables?: 'auto' | boolean;
  /** Descend into referenced block definitions. Enabled by default. */
  recursiveBlocks?: boolean;
  /** Group identical block references and expose their count as Quantity. Enabled by default. */
  aggregateBlocks?: boolean;
  includeInvisible?: boolean;
  includePaperSpace?: boolean;
  includeAnonymousBlocks?: boolean;
  maxDepth?: number;
  maxEntities?: number;
  maxRows?: number;
  maxCells?: number;
  minTextTableRows?: number;
  minTextTableColumns?: number;
  textRowTolerance?: number;
  textColumnTolerance?: number;
}

export interface CadBomJsonOptions {
  pretty?: boolean;
  /** Include DataLink connection strings, which can contain local paths or credentials. Disabled by default. */
  includeSensitiveData?: boolean;
}

export interface CadBomCsvOptions {
  /** Export this table; the largest table is used when omitted. */
  tableId?: string;
  delimiter?: ',' | ';' | '\t';
  lineEnding?: '\r\n' | '\n';
  includeUtf8Bom?: boolean;
  /** Prevent spreadsheet formula execution for cells beginning with =, +, -, or @. */
  escapeFormulas?: boolean;
}

export interface CadLoadInput {
  file?: File;
  fileName?: string;
  buffer?: ArrayBuffer | Uint8Array;
}

export interface CadReferenceInput {
  file?: File;
  fileName?: string;
  buffer?: ArrayBuffer | Uint8Array;
}

export interface CadMissingReference {
  kind: 'shx';
  fileName: string;
  identified: boolean;
  reason: 'not-loaded' | 'incompatible';
}

export interface CadLoadedReference {
  kind: 'shx';
  fileName: string;
  bytes: number;
  fontType: 'shapes' | 'bigfont' | 'unifont';
  glyphCount: number;
}

export interface CadReferenceState {
  missing: CadMissingReference[];
  loaded: CadLoadedReference[];
}

export type CadLoadProgressPhase =
  | 'read'
  | 'detect'
  | 'worker-start'
  | 'worker-ready'
  | 'wasm-init'
  | 'parse'
  | 'normalize'
  | 'render'
  | 'native-render'
  | 'done';

export interface CadLoadProgress {
  phase: CadLoadProgressPhase;
  message: string;
  format?: CadFormat;
  loaded?: number;
  total?: number;
  percent?: number;
  elapsedMs?: number;
}

export interface CadLoadOptions {
  wasmPath?: string;
  /**
   * Explicit text encoding for DXF sources. DXF files normally declare this in
   * `$DWGCODEPAGE`; use this only when legacy files are missing or lying about
   * their code page, for example `gb18030`, `big5`, `shift_jis` or `windows-1252`.
   */
  dxfEncoding?: string;
  preferDwgWasm?: boolean;
  maxInsertDepth?: number;
  includePaperSpace?: boolean;
  /**
   * Parse heavy formats in a Web Worker where available. DWG defaults to true
   * because LibreDWG WebAssembly initialization and decoding can block the UI.
   */
  useWorker?: boolean;
  /** Custom worker URL for bundlers/CDNs that cannot resolve the packaged worker URL. */
  workerUrl?: string | URL;
  /** Custom worker factory for applications that manage workers themselves. */
  workerFactory?: () => Worker;
  /** Milliseconds before an in-flight worker load is rejected. 0 disables timeout. */
  workerTimeoutMs?: number;
  /**
   * Transfer the input ArrayBuffer to the worker when it is safe to do so. This
   * avoids an extra copy for File inputs. ArrayBuffer inputs are copied by
   * default to avoid detaching caller-owned buffers.
   */
  transferInputBuffer?: boolean;
  /** Keep parser raw objects on the normalized document. Disabled by default for memory and worker cloning safety. */
  keepRaw?: boolean;
  /** Abort a pending load. For native parsers this terminates and recreates the worker. */
  signal?: AbortSignal;

  /** URL to dwf-viewer's optional 2D raster fallback WASM asset, usually /wasm/dwfv-render.wasm. */
  dwfWasmUrl?: string;
  /** Prefer dwf-viewer's WebGL paths for W2D/W3D rendering. */
  dwfPreferWebgl?: boolean;
  /** Allow dwf-viewer's WASM raster backend for complex 2D vector pages. */
  dwfPreferWasm?: boolean;
  /** Background passed to the native DWF renderer. Defaults to the active CAD canvas background. */
  dwfBackground?: string;
  /** DWF renderer device-pixel-ratio cap. */
  dwfMaxDevicePixelRatio?: number;
  /** DWF renderer maximum backing-store pixels per canvas. */
  dwfMaxCanvasPixels?: number;
  /** DWF WebGL GPU cache budget in bytes. */
  dwfMaxGpuCacheBytes?: number;
  /** Number of DWF pages/scenes kept in the native renderer cache. */
  dwfMaxCachedScenes?: number;
  /** DWF/XPS CAD line-weight rendering mode. Defaults to dwf-viewer's adaptive mode. */
  dwfLineWeightMode?: CadDwfLineWeightMode;
  /** Minimum CSS-pixel stroke used by the DWF/XPS adaptive line-weight renderer. */
  dwfMinStrokeCssPx?: number;
  /** Maximum overview stroke width before zoom restores physical line weights. */
  dwfMaxOverviewStrokeCssPx?: number;
  /** Minimum CSS-pixel text size shown in dense adaptive DWF/XPS overviews. */
  dwfMinTextCssPx?: number;
  /** Minimum filled area, in CSS pixels, shown in dense adaptive DWF/XPS overviews. */
  dwfMinFilledAreaCssPx?: number;
  /** Receives coarse loader progress events. */
  onProgress?: (progress: CadLoadProgress) => void;
}

export interface CadLoadResult {
  document: CadDocument;
  raw?: unknown;
  bytes: number;
  elapsedMs: number;
  format: CadFormat;
  warnings: string[];
}

export interface CadLoader {
  readonly id: string;
  readonly label: string;
  readonly formats: readonly CadFormat[];
  accepts(input: CadLoadInput, bytes?: Uint8Array): boolean;
  load(input: CadLoadInput, options?: CadLoadOptions): Promise<CadLoadResult>;
}



export interface CadNativeRenderableLoader extends CadLoader {
  readonly nativeRenderer: true;
  mount(input: CadLoadInput, host: HTMLElement, options?: CadLoadOptions): Promise<CadLoadResult>;
  unmount(): void;
  fit?(): void;
  zoomIn?(): void;
  zoomOut?(): void;
  resize?(): void;
  setNativeOptions?(options: CadLoadOptions): void;
}

export function isCadNativeRenderableLoader(loader: CadLoader): loader is CadNativeRenderableLoader {
  const candidate = loader as Partial<CadNativeRenderableLoader>;
  return candidate.nativeRenderer === true && typeof candidate.mount === 'function';
}

export interface CadSummary {
  format: CadFormat;
  sourceName?: string;
  entityCount: number;
  layerCount: number;
  blockCount: number;
  pageCount: number;
  byType: Record<string, number>;
  warnings: string[];
}
