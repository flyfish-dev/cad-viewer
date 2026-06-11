import './styles.css';
export { CadViewer, createCadViewer } from './viewer/CadViewer';
export type { CadViewerLoadResult, CadViewerOptions, CadViewerRendererBackend, CadRenderer } from './viewer/CadViewer';

export { CadCanvasRenderer } from './viewer/CadCanvasRenderer';
export { CadWebGLRenderer, isWebGLAvailable } from './viewer/CadWebGLRenderer';
export type { CanvasViewerOptions, RenderStats, ViewChangeEvent, ViewState } from './viewer/CadCanvasRenderer';

export { CadLoaderRegistry, createDefaultLoaderRegistry, DwgLoader, DwgWorkerClient, DxfLoader, DwfLoader, DwfUnsupportedError, supportsDwgWorker } from './loaders';

export { createCadDocument, inferEntityKind, normalizeCadEntity, summarizeCadDocument } from './core/entity';
export { detectCadFormat, readInputBytes } from './core/format';
export { colorFromAci, colorFromTrueColor, resolveCadColor } from './core/color';

export type {
  CadBlock,
  CadBounds,
  CadDocument,
  CadEntity,
  CadEntityKind,
  CadFormat,
  CadLayer,
  CadLoadInput,
  CadLoadOptions,
  CadLoadProgress,
  CadLoadProgressPhase,
  CadLoadResult,
  CadLoader,
  CadPage,
  CadPathCommand,
  CadPoint,
  CadPoint2D,
  CadPoint3D,
  CadSummary
} from './core/types';
