import type { CadEntity, CadHatchGeometry, CadPoint3D } from './types.js';

type RecordValue = Record<string, unknown>;
type Point = CadPoint3D;
const MAX_VERTICES = 4096;
const MAX_DEFINITIONS = 256;
const MAX_ROWS = 20000;
const MAX_OPERATIONS = 2000000;
const MAX_PRIMITIVES = 50000;

/** Compile authored DWG pattern definitions once, before worker transfer. */
export function normalizeCadHatch(raw: RecordValue): { loops: NonNullable<CadEntity['loops']>; hatch: CadHatchGeometry } {
  const loops: NonNullable<CadEntity['loops']> = [];
  const hatch: CadHatchGeometry = { status: 'unsupported', patternName: typeof raw.patternName === 'string' ? raw.patternName : undefined, segments: [], dots: [], diagnostics: [] };
  const fail = (message: string, budget = false) => {
    hatch.status = budget ? 'budget-exceeded' : 'unsupported';
    hatch.segments = [];
    hatch.dots = [];
    hatch.diagnostics = [message];
    return { loops, hatch };
  };
  const paths = raw.boundaryPaths;
  if (!Array.isArray(paths) || !paths.length) return fail('HATCH has no supported boundary paths.');
  if (paths.length > 128) return fail('HATCH boundary budget exceeded.', true);
  let vertices = 0;
  for (const value of paths) {
    const path = object(value);
    if (!path) return fail('HATCH contains an invalid boundary.');
    const polygon: Point[] = [];
    if (Array.isArray(path.vertices)) {
      if (path.isClosed !== true && path.isClosed !== 1) return fail('Open HATCH polyline boundaries are unsupported.');
      if (path.vertices.length + vertices > MAX_VERTICES) return fail('HATCH vertex budget exceeded.', true);
      for (const item of path.vertices) {
        const p = point(item);
        if (!p || Number(object(item)?.bulge ?? 0) !== 0) return fail('Curved or invalid HATCH polyline boundaries are unsupported.');
        polygon.push(p);
      }
    } else if (Array.isArray(path.edges)) {
      if (path.edges.length + vertices > MAX_VERTICES) return fail('HATCH vertex budget exceeded.', true);
      let end: Point | undefined;
      for (const item of path.edges) {
        const edge = object(item);
        const start = point(edge?.start), next = point(edge?.end);
        if (Number(edge?.type) !== 1 || !start || !next) return fail('Nonlinear or invalid HATCH boundary edges are unsupported.');
        if (end && !coincident(end, start)) return fail('Disconnected HATCH boundary edges are unsupported.');
        polygon.push(start);
        end = next;
      }
      if (!end || !polygon.length || !coincident(end, polygon[0])) return fail('Open HATCH boundaries are unsupported.');
    } else return fail('HATCH boundary geometry is unsupported.');
    if (polygon.length > 1 && coincident(polygon[0], polygon[polygon.length - 1])) polygon.pop();
    if (polygon.length < 3) return fail('HATCH boundary requires at least three vertices.');
    vertices += polygon.length;
    loops.push({ vertices: polygon, isClosed: true });
  }
  const extrusion = point(raw.extrusionDirection);
  if (extrusion && (Math.abs(extrusion.x) > 1e-10 || Math.abs(extrusion.y) > 1e-10 || Math.abs((extrusion.z ?? 1) - 1) > 1e-10)) {
    return fail('Non-WCS HATCH extrusion is unsupported.');
  }
  if (Number(raw.solidFill ?? 0) !== 0 || Number(raw.gradientFlag ?? 0) !== 0) return fail('This HATCH compiler supports line patterns only.');
  if (loops.length > 1 && Number(raw.hatchStyle ?? 0) !== 0) return fail('Nested HATCH boundaries require normal island detection.');
  const definitions = raw.definitionLines;
  if (!Array.isArray(definitions) || !definitions.length) return fail('HATCH has no usable pattern definition lines.');
  if (definitions.length > MAX_DEFINITIONS) return fail('HATCH definition budget exceeded.', true);

  let operations = 0;
  const spend = (count: number) => {
    operations += count;
    if (!Number.isFinite(operations) || operations > MAX_OPERATIONS) throw new Error('budget');
  };
  const append = (start: Point, end?: Point) => {
    if (hatch.segments.length + hatch.dots.length >= MAX_PRIMITIVES) throw new Error('budget');
    if (!point(start) || (end && !point(end))) throw new Error('invalid');
    if (end) hatch.segments.push({ start, end });
    else hatch.dots.push(start);
  };
  const polygons = loops.map(loop => loop.vertices!);
  try {
    for (const value of definitions) {
      const definition = object(value);
      const angle = number(definition?.angle), base = point(definition?.base), offset = point(definition?.offset);
      const dashes = definition?.dashLengths;
      if (angle === undefined || !base || !offset || !Array.isArray(dashes) || dashes.length > 256 || !dashes.every(v => typeof v === 'number' && Number.isFinite(v))) throw new Error('invalid');
      const dx = Math.cos(angle), dy = Math.sin(angle);
      const step = -dy * offset.x + dx * offset.y;
      // LibreDWG exposes already transformed definition lines: applying the
      // entity patternAngle/patternScale again would rotate/scale them twice.
      if (!Number.isFinite(step) || Math.abs(step) < 1e-12) throw new Error('invalid');
      let min = Infinity, max = -Infinity;
      for (const polygon of polygons) for (const p of polygon) {
        const row = (-dy * (p.x - base.x) + dx * (p.y - base.y)) / step;
        min = Math.min(min, row); max = Math.max(max, row);
      }
      const first = Math.ceil(min - 1e-8), last = Math.floor(max + 1e-8);
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first + 1 > MAX_ROWS) throw new Error('budget');
      spend(Math.max(0, last - first + 1) * vertices);
      const period = dashes.reduce((sum: number, value: number) => sum + Math.abs(value), 0);
      if (dashes.length && (!Number.isFinite(period) || period < 1e-12)) throw new Error('invalid');
      for (let row = first; row <= last; row++) {
        const origin = { x: base.x + row * offset.x, y: base.y + row * offset.y };
        const hits: number[] = [];
        for (const polygon of polygons) for (let i = 0; i < polygon.length; i++) {
          const a = polygon[i], b = polygon[(i + 1) % polygon.length];
          const av = -dy * (a.x - origin.x) + dx * (a.y - origin.y);
          const bv = -dy * (b.x - origin.x) + dx * (b.y - origin.y);
          // Half-open crossings count each vertex once and retain all islands.
          if ((av <= 0 && bv > 0) || (bv <= 0 && av > 0)) {
            const u = -av / (bv - av);
            hits.push(dx * (a.x + u * (b.x - a.x) - origin.x) + dy * (a.y + u * (b.y - a.y) - origin.y));
          }
        }
        hits.sort((a, b) => a - b);
        if (hits.length % 2) throw new Error('invalid');
        const at = (t: number): Point => ({ x: origin.x + t * dx, y: origin.y + t * dy });
        for (let i = 0; i + 1 < hits.length; i += 2) {
          const a = hits[i], b = hits[i + 1];
          if (b - a < 1e-9) continue;
          if (!dashes.length) { append(at(a), at(b)); continue; }
          const from = Math.floor(a / period) - 1, to = Math.floor(b / period);
          if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) throw new Error('budget');
          spend((to - from + 1) * dashes.length);
          for (let cycle = from; cycle <= to; cycle++) {
            let cursor = cycle * period;
            for (const dash of dashes) {
              const end = cursor + Math.abs(dash);
              if (dash > 0 && Math.min(b, end) - Math.max(a, cursor) > 1e-9) append(at(Math.max(a, cursor)), at(Math.min(b, end)));
              else if (dash === 0 && cursor >= a && cursor <= b) append(at(cursor));
              cursor = end;
            }
          }
        }
      }
    }
    hatch.status = 'ready';
    return { loops, hatch };
  } catch (error) {
    const budget = error instanceof Error && error.message === 'budget';
    return fail(budget ? 'HATCH pattern geometry budget exceeded; no partial fill was emitted.' : 'Invalid or unsupported HATCH pattern definition; no partial fill was emitted.', budget);
  }
}

function object(value: unknown): RecordValue | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined; }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function point(value: unknown): Point | undefined {
  const p = object(value), x = number(p?.x), y = number(p?.y);
  return x === undefined || y === undefined ? undefined : { x, y, ...(number(p?.z) === undefined ? {} : { z: number(p?.z) }) };
}
function coincident(a: Point, b: Point): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= Math.max(1e-8, Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y)) * 1e-12);
}
