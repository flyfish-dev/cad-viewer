import { inferEntityKind } from './entity';
import { boundsValid, ellipsePoints, emptyBounds, includeCircle, includePoint, isFinitePoint, mergeBounds, paddedBounds } from './geometry';
import { matrixFromInsert, transformEntity } from './transform';
import type { CadBlock, CadBounds, CadDocument, CadEntity, CadFitMode } from './types';

export interface CadBoundsOptions {
  maxInsertDepth?: number;
  maxCurveSegments?: number;
}

interface BoundsContext {
  document: CadDocument;
  maxInsertDepth: number;
  maxCurveSegments: number;
}

const DEFAULT_MAX_INSERT_DEPTH = 16;
const DEFAULT_MAX_CURVE_SEGMENTS = 96;
const MIN_SAVED_VIEW_CONTENT_RATIO = 0.01;

export function computeCadDocumentBounds(document: CadDocument, options: CadBoundsOptions = {}): CadBounds {
  const bounds = emptyBounds();
  for (const page of document.pages ?? []) {
    includePoint(bounds, { x: 0, y: 0 });
    includePoint(bounds, { x: page.width, y: page.height });
  }

  const context = createBoundsContext(document, options);
  for (const entity of document.entities) mergeBounds(bounds, computeEntityBounds(entity, context));
  return paddedBounds(bounds);
}

export function resolveCadFitBounds(
  document: CadDocument,
  extents: CadBounds,
  mode: CadFitMode = 'auto',
  options: CadBoundsOptions = {}
): CadBounds {
  if (mode === 'extents') return extents;

  const savedViewBounds = resolveCadSavedViewBounds(document);
  if (!savedViewBounds) return extents;
  if (mode === 'saved-view') return savedViewBounds;

  const visibleContent = emptyBounds();
  const context = createBoundsContext(document, options);
  let intersectingEntities = 0;
  for (const entity of document.entities) {
    const intersection = intersectBounds(computeEntityBounds(entity, context), savedViewBounds);
    if (!intersection) continue;
    intersectingEntities++;
    mergeBounds(visibleContent, intersection);
  }

  if (intersectingEntities === 0 || !hasMeaningfulExtent(visibleContent, savedViewBounds)) {
    return savedViewBounds;
  }
  return paddedBounds(visibleContent);
}

export function resolveCadSavedViewBounds(document: CadDocument): CadBounds | undefined {
  const view = document.savedView;
  if (!view || view.source !== 'vport' || view.sceneTransformApplied !== true || !isFinitePoint(view.center)) return undefined;

  const height = Number(view.viewHeight);
  const aspectRatio = Number(view.aspectRatio);
  if (!Number.isFinite(height) || height <= 1e-9 || !Number.isFinite(aspectRatio) || aspectRatio <= 1e-9) return undefined;

  const width = height * aspectRatio;
  return {
    minX: view.center.x - width / 2,
    minY: view.center.y - height / 2,
    maxX: view.center.x + width / 2,
    maxY: view.center.y + height / 2
  };
}

function createBoundsContext(document: CadDocument, options: CadBoundsOptions): BoundsContext {
  return {
    document,
    maxInsertDepth: Math.max(0, Math.floor(options.maxInsertDepth ?? DEFAULT_MAX_INSERT_DEPTH)),
    maxCurveSegments: Math.max(12, Math.floor(options.maxCurveSegments ?? DEFAULT_MAX_CURVE_SEGMENTS))
  };
}

function computeEntityBounds(entity: CadEntity, context: BoundsContext, depth = 0): CadBounds {
  const bounds = emptyBounds();
  includeEntityBounds(bounds, entity, context, depth);
  return bounds;
}

function includeEntityBounds(bounds: CadBounds, entity: CadEntity, context: BoundsContext, depth: number): void {
  const type = String(entity.type ?? '').toUpperCase();
  const kind = entity.kind ?? inferEntityKind(type);
  if (kind === 'insert') {
    const block = lookupBlock(context.document, entity.blockName ?? entity.name);
    if (block && depth < context.maxInsertDepth) {
      const matrix = matrixFromInsert(entity, block.basePoint ?? { x: 0, y: 0 });
      for (const child of block.entities) includeEntityBounds(bounds, transformEntity(child, matrix), context, depth + 1);
      return;
    }
  }

  if (kind === 'line') {
    if (isFinitePoint(entity.startPoint)) includePoint(bounds, entity.startPoint);
    if (isFinitePoint(entity.endPoint)) includePoint(bounds, entity.endPoint);
  } else if (kind === 'circle' || kind === 'arc') {
    if (isFinitePoint(entity.center) && Number.isFinite(entity.radius)) includeCircle(bounds, entity.center, Number(entity.radius));
  } else if (kind === 'polyline' || kind === 'solid' || kind === 'spline') {
    for (const point of [...(entity.vertices ?? []), ...(entity.points ?? []), ...(entity.controlPoints ?? []), ...(entity.fitPoints ?? [])]) {
      if (isFinitePoint(point)) includePoint(bounds, point);
    }
  } else if (kind === 'ellipse') {
    if (isFinitePoint(entity.center) && isFinitePoint(entity.majorAxisEndPoint)) {
      for (const point of ellipsePoints(
        entity.center,
        entity.majorAxisEndPoint,
        Number(entity.axisRatio ?? 1),
        Number(entity.startAngle ?? 0),
        Number(entity.endAngle ?? Math.PI * 2),
        context.maxCurveSegments
      )) includePoint(bounds, point);
    }
  } else if (kind === 'path') {
    for (const command of entity.commands ?? []) for (const point of command.points) includePoint(bounds, point);
  } else if (kind === 'hatch') {
    for (const loop of entity.loops ?? []) {
      for (const point of loop.vertices ?? []) includePoint(bounds, point);
      for (const command of loop.commands ?? []) for (const point of command.points) includePoint(bounds, point);
    }
  } else {
    const anchor = entityAnchor(entity);
    if (anchor) includePoint(bounds, anchor);
  }
}

function entityAnchor(entity: CadEntity) {
  for (const key of ['startPoint', 'insertionPoint', 'center', 'point', 'location']) {
    const point = entity[key];
    if (isFinitePoint(point)) return point;
  }
  if (Array.isArray(entity.vertices) && isFinitePoint(entity.vertices[0])) return entity.vertices[0];
  if (Array.isArray(entity.commands)) {
    const command = entity.commands.find((item) => item.points.length > 0);
    if (command) return command.points[0];
  }
  return undefined;
}

function lookupBlock(document: CadDocument, name: string | undefined): CadBlock | undefined {
  if (!name) return undefined;
  return document.blocks[name]
    ?? document.blocks[name.toLowerCase()]
    ?? Object.values(document.blocks).find((block) => block.name.toLowerCase() === name.toLowerCase());
}

function intersectBounds(a: CadBounds, b: CadBounds): CadBounds | undefined {
  if (!boundsValid(a) || !boundsValid(b)) return undefined;
  const intersection = {
    minX: Math.max(a.minX, b.minX),
    minY: Math.max(a.minY, b.minY),
    maxX: Math.min(a.maxX, b.maxX),
    maxY: Math.min(a.maxY, b.maxY)
  };
  return boundsValid(intersection) ? intersection : undefined;
}

function hasMeaningfulExtent(content: CadBounds, savedView: CadBounds): boolean {
  if (!boundsValid(content) || !boundsValid(savedView)) return false;
  const contentDiagonal = Math.hypot(content.maxX - content.minX, content.maxY - content.minY);
  const savedViewDiagonal = Math.hypot(savedView.maxX - savedView.minX, savedView.maxY - savedView.minY);
  return savedViewDiagonal > 1e-9 && contentDiagonal / savedViewDiagonal >= MIN_SAVED_VIEW_CONTENT_RATIO;
}
