import './styles.css';
export { CadViewer, createCadViewer } from './viewer/CadViewer';
export type { CadViewerLoadResult, CadViewerOptions, CadViewerRendererBackend, CadRenderer } from './viewer/CadViewer';

export { CadCanvasRenderer } from './viewer/CadCanvasRenderer';
export { CadWebGLRenderer, isWebGLAvailable } from './viewer/CadWebGLRenderer';
export type { CanvasViewerOptions, RenderStats, ViewChangeEvent, ViewState } from './viewer/CadCanvasRenderer';

export { CadLoaderRegistry, createDefaultLoaderRegistry, DwgLoader, DwgWorkerClient, DxfLoader, DwfLoader, supportsDwgWorker } from './loaders';

export { createCadDocument, inferEntityKind, isCadPolylineClosed, normalizeCadEntity, summarizeCadDocument } from './core/entity';
export { computeCadDocumentBounds, resolveCadFitBounds, resolveCadSavedViewBounds } from './core/bounds';
export type { CadBoundsOptions } from './core/bounds';
export { createCadSceneDocument } from './core/scene';
export { applyByBlockLineTypeInheritance, createDashedCadPrimitives, createDashedCadSegments, resolveCadLinePattern, resolveCadLineTypeReference } from './core/linetype';
export type { CadDashedPrimitives, ResolvedCadLinePattern, ResolvedCadLinePatternRun } from './core/linetype';
export { normalizeDwgDatabase } from './loaders/dwg/DwgParser';
export { detectCadFormat, readInputBytes } from './core/format';
export { isCadNativeRenderableLoader } from './core/types';
export { colorFromAci, colorFromTrueColor, resolveCadColor } from './core/color';

export type {
  CadBlock,
  CadBounds,
  CadDocument,
  CadEntity,
  CadEntityKind,
  CadFitMode,
  CadFormat,
  CadLayer,
  CadLineType,
  CadLineTypeElement,
  CadLoadInput,
  CadLoadOptions,
  CadLoadProgress,
  CadLoadProgressPhase,
  CadLoadResult,
  CadLoader,
  CadNativeRenderableLoader,
  CadPage,
  CadPathCommand,
  CadPoint,
  CadPoint2D,
  CadPoint3D,
  CadSavedView,
  CadSceneTransform2D,
  CadSummary
} from './core/types';
