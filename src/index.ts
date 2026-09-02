import './styles.css';
export { CadViewer, createCadViewer } from './viewer/CadViewer';
export type { CadViewerLoadResult, CadViewerOptions, CadViewerRendererBackend, CadRenderer } from './viewer/CadViewer';

export { CadCanvasRenderer } from './viewer/CadCanvasRenderer';
export { CadWebGLRenderer, isWebGLAvailable } from './viewer/CadWebGLRenderer';
export type { CanvasViewerOptions, RenderStats, ViewChangeEvent, ViewState } from './viewer/CadCanvasRenderer';

export { CadLoaderRegistry, createDefaultLoaderRegistry, DwgLoader, DwgWorkerClient, DxfLoader, DwfLoader, supportsDwgWorker } from './loaders';

export { cadEntityWorldStrokeWidth, createCadDocument, inferEntityKind, isCadPolylineClosed, normalizeCadDataValue, normalizeCadEntity, normalizeCadTableData, summarizeCadDocument } from './core/entity';
export { extractCadBom, serializeCadBomCsv, serializeCadBomJson } from './core/bom';
export { computeCadDocumentBounds, resolveCadFitBounds, resolveCadSavedViewBounds } from './core/bounds';
export type { CadBoundsOptions } from './core/bounds';
export { createCadSceneDocument } from './core/scene';
export { createCadRenderDocument, readCadColorPolicy } from './core/colorPolicy';
export type { CadColorMode, CadColorPolicy } from './core/colorPolicy';
export { applyByBlockLineTypeInheritance, createDashedCadPrimitives, createDashedCadSegments, resolveCadLinePattern, resolveCadLineTypeReference, transformCadLineTypeGlyph } from './core/linetype';
export type { CadDashedPrimitives, CadLineTypeMarker, ResolvedCadLinePattern, ResolvedCadLinePatternRun } from './core/linetype';
export { CadShxFontRegistry } from './core/shx';
export type { CadShxGlyph, CadShxGlyphResolver } from './core/shx';
export { normalizeDwgDatabase } from './loaders/dwg/DwgParser';
export { detectCadFormat, readInputBytes } from './core/format';
export { isCadNativeRenderableLoader } from './core/types';
export { applyCadColorPolicy, colorFromAci, colorFromTrueColor, resolveCadColor, resolveFillColor } from './core/color';
export type { CadColorContrastMode, ColorResolveOptions } from './core/color';

export type {
  CadBlock,
  CadBom,
  CadBomColumn,
  CadBomCsvOptions,
  CadBomJsonOptions,
  CadBomOptions,
  CadBomRow,
  CadBomSourceKind,
  CadBomSummary,
  CadBomTable,
  CadBomWarning,
  CadBomWarningCode,
  CadBounds,
  CadDataLink,
  CadDataScalar,
  CadDataTable,
  CadDataTableColumn,
  CadDataValue,
  CadDictionary,
  CadDictionaryEntry,
  CadDocument,
  CadEntity,
  CadEntityKind,
  CadFitMode,
  CadFormat,
  CadLayer,
  CadLineType,
  CadLineTypeElement,
  CadLoadedReference,
  CadLoadInput,
  CadLoadOptions,
  CadLoadProgress,
  CadLoadProgressPhase,
  CadLoadResult,
  CadLoader,
  CadNativeRenderableLoader,
  CadMissingReference,
  CadPage,
  CadPathCommand,
  CadPoint,
  CadPoint2D,
  CadPoint3D,
  CadReferenceInput,
  CadReferenceState,
  CadSavedView,
  CadSceneTransform2D,
  CadTableCell,
  CadTableData,
  CadXData,
  CadXDataEntry,
  CadXRecord,
  CadXRecordGroup,
  CadSummary
} from './core/types';
