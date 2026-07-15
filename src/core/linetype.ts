import type { CadDocument, CadEntity, CadLayer, CadLineType, CadPoint2D } from './types';

export interface ResolvedCadLinePattern {
  name: string;
  /** Alternating world-unit draw/gap lengths, always starting with draw. */
  segments: number[];
  /** Exact signed-pattern semantics used by the renderers. Zero-length runs are marker events. */
  runs: ResolvedCadLinePatternRun[];
  period: number;
}

export interface ResolvedCadLinePatternRun {
  draw: boolean;
  /** World-unit phase advance. A zero-length run does not change the pattern period. */
  length: number;
  /** Render a screen-space dot as a fallback for a DXF dot or unavailable SHX glyph. */
  marker: boolean;
}

export interface CadDashedPrimitives {
  segments: Array<readonly [CadPoint2D, CadPoint2D]>;
  dots: CadPoint2D[];
}

const DEFAULT_MAX_DASH_PRIMITIVES = 100_000;

const BY_LAYER = new Set(['', 'bylayer', '15']);
const BY_BLOCK = new Set(['byblock', '14']);
const CONTINUOUS = new Set(['continuous', '16']);

const refKey = (value: unknown) => String(value ?? '').trim().toLowerCase();

export function isByBlockLineType(value: unknown): boolean {
  return BY_BLOCK.has(refKey(value));
}

export function applyByBlockLineTypeInheritance(entity: CadEntity, parent: CadEntity, document?: CadDocument): CadEntity {
  if (!isByBlockLineType(entity.lineType)) return entity;
  const parentRef = resolveCadLineTypeReference(parent, document);
  return {
    ...entity,
    lineType: parentRef || 'Continuous',
    lineTypeScale: finitePositive(entity.lineTypeScale, 1) * finitePositive(parent.lineTypeScale, 1)
  };
}

export function resolveCadLineTypeReference(entity: CadEntity, document?: CadDocument): string {
  let reference = String(entity.lineType ?? '').trim();
  const key = refKey(reference);
  if (BY_LAYER.has(key)) {
    reference = lookupLayer(document, entity.layer)?.lineType ?? 'Continuous';
  } else if (BY_BLOCK.has(key)) {
    reference = 'Continuous';
  }
  return reference || 'Continuous';
}

export function resolveCadLinePattern(entity: CadEntity, document?: CadDocument): ResolvedCadLinePattern | undefined {
  if (!document) return undefined;
  const reference = resolveCadLineTypeReference(entity, document);
  const key = refKey(reference);
  if (CONTINUOUS.has(key) || BY_LAYER.has(key) || BY_BLOCK.has(key)) return undefined;
  const definition = lookupLineType(document, reference);
  if (!definition?.pattern.length) return undefined;

  // CELTSCALE is the authoring default for new entities. Once an entity has a
  // stored lineTypeScale it replaces (rather than multiplies) that default.
  const entityScale = finitePositive(entity.lineTypeScale, finitePositive(document.header?.CELTSCALE, 1));
  const globalScale = finitePositive(document.header?.LTSCALE, 1) * entityScale;
  const runs = patternRuns(definition, globalScale);
  const period = runs.reduce((sum, run) => sum + run.length, 0);
  if (!Number.isFinite(period) || period <= 1e-9) return undefined;
  const hasGap = runs.some((run) => !run.draw && run.length > 1e-12);
  const hasMarker = runs.some((run) => run.marker);
  if (!hasGap && !hasMarker) return undefined;
  return { name: definition.name, segments: canvasDashSegments(runs, hasGap), runs, period };
}

export function createDashedCadSegments(
  points: CadPoint2D[],
  closed: boolean,
  pattern: ResolvedCadLinePattern
): Array<readonly [CadPoint2D, CadPoint2D]> {
  return createDashedCadPrimitives(points, closed, pattern).segments;
}

/**
 * Expands one CAD path while keeping the LTYPE phase continuous across every
 * polyline edge. DXF zero-length dots and unavailable complex SHX glyphs are
 * returned as screen-space marker points instead of sub-pixel GL_LINES.
 */
export function createDashedCadPrimitives(
  points: CadPoint2D[],
  closed: boolean,
  pattern: ResolvedCadLinePattern,
  maxPrimitives = DEFAULT_MAX_DASH_PRIMITIVES
): CadDashedPrimitives {
  const valid = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (valid.length < 2 || pattern.runs.length === 0) return { segments: [], dots: [] };
  const edges: Array<readonly [CadPoint2D, CadPoint2D]> = [];
  for (let index = 0; index < valid.length - 1; index++) edges.push([valid[index], valid[index + 1]]);
  if (closed) edges.push([valid[valid.length - 1], valid[0]]);

  const finiteLimit = Number.isFinite(maxPrimitives) ? Math.max(1, Math.floor(maxPrimitives)) : DEFAULT_MAX_DASH_PRIMITIVES;
  const totalLength = edges.reduce((sum, [start, end]) => sum + Math.hypot(end.x - start.x, end.y - start.y), 0);
  const estimatedCycles = pattern.period > 1e-12 ? totalLength / pattern.period : Number.POSITIVE_INFINITY;
  const estimatedPrimitives = estimatedCycles * Math.max(1, pattern.runs.length);
  if (!Number.isFinite(estimatedPrimitives) || estimatedPrimitives > finiteLimit) {
    // A corrupt or microscopic pattern can otherwise expand one entity into
    // millions of allocations. Keeping the source edges visible is a safer
    // degradation than freezing the viewer or dropping the entity entirely.
    return { segments: edges, dots: [] };
  }

  const output: CadDashedPrimitives = { segments: [], dots: [] };
  let runIndex = 0;
  let remaining = pattern.runs[0].length;
  let markerPending = true;
  const addDot = (point: CadPoint2D) => {
    const previous = output.dots[output.dots.length - 1];
    if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) <= 1e-10) return;
    output.dots.push(point);
  };
  const advance = () => {
    runIndex = (runIndex + 1) % pattern.runs.length;
    remaining = pattern.runs[runIndex].length;
    markerPending = true;
  };
  for (const [start, end] of edges) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= 1e-14) continue;
    let offset = 0;
    while (offset < length - 1e-12) {
      let zeroRunCount = 0;
      while (remaining <= 1e-12 && zeroRunCount < pattern.runs.length) {
        const run = pattern.runs[runIndex];
        if (markerPending && run.marker) {
          const ratio = offset / length;
          addDot({ x: start.x + dx * ratio, y: start.y + dy * ratio });
        }
        advance();
        zeroRunCount++;
      }
      if (remaining <= 1e-12) break;
      const run = pattern.runs[runIndex];
      if (markerPending) {
        if (run.marker) {
          const ratio = offset / length;
          addDot({ x: start.x + dx * ratio, y: start.y + dy * ratio });
        }
        markerPending = false;
      }
      const take = Math.min(remaining, length - offset);
      if (run.draw && take > 1e-12) {
        const from = offset / length;
        const to = (offset + take) / length;
        output.segments.push([
          { x: start.x + dx * from, y: start.y + dy * from },
          { x: start.x + dx * to, y: start.y + dy * to }
        ]);
      }
      offset += take;
      remaining -= take;
      if (remaining <= 1e-12) {
        advance();
      }
    }
  }
  return output;
}

function patternRuns(definition: CadLineType, scale: number): ResolvedCadLinePatternRun[] {
  const out: ResolvedCadLinePatternRun[] = [];
  for (const element of definition.pattern) {
    const length = Number(element.length);
    const complex = Number(element.elementTypeFlag ?? 0) !== 0;
    if (!Number.isFinite(length)) continue;
    // Group 49 keeps its sign semantics even when group 74 attaches a shape
    // or text glyph: positive is a baseline dash, negative is a gap and zero
    // is a dot. The glyph is an additional marker, not a replacement dash.
    out.push({ draw: length >= 0, length: Math.abs(length) * scale, marker: length >= 0 && (length === 0 || complex) });
  }
  return out;
}

function canvasDashSegments(runs: ResolvedCadLinePatternRun[], hasGap: boolean): number[] {
  if (!hasGap) return [];
  const merged: Array<{ draw: boolean; length: number }> = [];
  for (const run of runs) {
    if (run.length <= 1e-12) continue;
    const previous = merged[merged.length - 1];
    if (previous?.draw === run.draw) previous.length += run.length;
    else merged.push({ draw: run.draw, length: run.length });
  }
  const segments: number[] = [];
  for (const run of merged) {
    const expectedDraw = segments.length % 2 === 0;
    if (run.draw !== expectedDraw) segments.push(1e-9);
    segments.push(run.length);
  }
  if (segments.length % 2 === 1) segments.push(1e-9);
  return segments;
}

function lookupLineType(document: CadDocument, reference: string): CadLineType | undefined {
  const key = refKey(reference);
  const lineTypes = document.lineTypes ?? {};
  return lineTypes[reference]
    ?? lineTypes[key]
    ?? Object.values(lineTypes).find((lineType) => refKey(lineType.name) === key || refKey(lineType.handle) === key);
}

function lookupLayer(document: CadDocument | undefined, name: string | undefined): CadLayer | undefined {
  if (!document || !name) return undefined;
  return document.layers[name]
    ?? document.layers[name.toLowerCase()]
    ?? Object.values(document.layers).find((layer) => layer.name.toLowerCase() === name.toLowerCase());
}

function finitePositive(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
