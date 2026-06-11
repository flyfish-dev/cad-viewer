export type CadFormat = 'dwg' | 'dxf' | 'dwf' | 'dwfx' | 'xps' | 'unknown';

export interface CadPoint2D {
  x: number;
  y: number;
}

export interface CadPoint3D extends CadPoint2D {
  z?: number;
}

export type CadPoint = CadPoint2D | CadPoint3D;

export interface CadBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

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

  insertionPoint?: CadPoint3D;
  text?: string;
  value?: string;
  height?: number;
  textHeight?: number;
  rotation?: number;
  scale?: CadPoint3D;
  name?: string;
  blockName?: string;
  attribs?: CadEntity[];

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
  blocks: Record<string, CadBlock>;
  entities: CadEntity[];
  pages?: CadPage[];
  metadata: Record<string, unknown>;
  warnings: string[];
  raw?: unknown;
}

export interface CadLoadInput {
  file?: File;
  fileName?: string;
  buffer?: ArrayBuffer | Uint8Array;
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
