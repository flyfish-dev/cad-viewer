import type { CadEntity, CadPathCommand, CadPoint2D, CadPoint3D } from './types';

export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY_MATRIX: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function multiplyMatrix(left: Matrix2D, right: Matrix2D): Matrix2D {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f
  };
}

export function translationMatrix(x: number, y: number): Matrix2D {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function rotationMatrix(angle: number): Matrix2D {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
}

export function scaleMatrix(x: number, y = x): Matrix2D {
  return { a: x, b: 0, c: 0, d: y, e: 0, f: 0 };
}

export function transformPoint(point: CadPoint2D | CadPoint3D, matrix: Matrix2D): CadPoint3D {
  return {
    x: point.x * matrix.a + point.y * matrix.c + matrix.e,
    y: point.x * matrix.b + point.y * matrix.d + matrix.f,
    z: 'z' in point ? point.z : undefined
  };
}

export function transformPathCommands(commands: CadPathCommand[] | undefined, matrix: Matrix2D): CadPathCommand[] | undefined {
  if (!commands) return undefined;
  return commands.map((command) => ({ cmd: command.cmd, points: command.points.map((p) => transformPoint(p, matrix)) }));
}

export function matrixFromInsert(entity: CadEntity, basePoint: CadPoint3D = { x: 0, y: 0 }): Matrix2D {
  const insertion = entity.insertionPoint ?? { x: 0, y: 0 };
  const scaleValue = entity.scale;
  const sx = typeof scaleValue === 'object' && scaleValue ? Number(scaleValue.x ?? 1) : Number((entity as Record<string, unknown>).scaleX ?? 1);
  const sy = typeof scaleValue === 'object' && scaleValue ? Number(scaleValue.y ?? sx) : Number((entity as Record<string, unknown>).scaleY ?? sx);
  const rotation = Number(entity.rotation ?? 0);
  let matrix = translationMatrix(insertion.x, insertion.y);
  matrix = multiplyMatrix(matrix, rotationMatrix(Number.isFinite(rotation) ? rotation : 0));
  matrix = multiplyMatrix(matrix, scaleMatrix(Number.isFinite(sx) ? sx : 1, Number.isFinite(sy) ? sy : 1));
  matrix = multiplyMatrix(matrix, translationMatrix(-basePoint.x, -basePoint.y));
  return matrix;
}

export function transformEntity(entity: CadEntity, matrix: Matrix2D): CadEntity {
  const clone: CadEntity = { ...entity };
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  const scaleApprox = Math.sqrt(Math.abs(determinant));
  const scaleX = Math.hypot(matrix.a, matrix.b);
  const scaleY = Math.hypot(matrix.c, matrix.d);
  if (entity.startPoint) clone.startPoint = transformPoint(entity.startPoint, matrix);
  if (entity.endPoint) clone.endPoint = transformPoint(entity.endPoint, matrix);
  if (entity.center) clone.center = transformPoint(entity.center, matrix);
  if (entity.insertionPoint) clone.insertionPoint = transformPoint(entity.insertionPoint, matrix);
  if (entity.majorAxisEndPoint) {
    const origin = transformPoint({ x: 0, y: 0 }, matrix);
    const major = transformPoint(entity.majorAxisEndPoint, matrix);
    clone.majorAxisEndPoint = { x: major.x - origin.x, y: major.y - origin.y, z: major.z };
  }
  if (entity.vertices) {
    clone.vertices = entity.vertices.map((point) => ({
      ...transformPoint(point, matrix),
      bulge: point.bulge,
      startWidth: scaleDimension(point.startWidth, scaleApprox),
      endWidth: scaleDimension(point.endWidth, scaleApprox)
    }));
  }
  if (entity.points) clone.points = entity.points.map((p) => transformPoint(p, matrix));
  if (entity.controlPoints) clone.controlPoints = entity.controlPoints.map((p) => transformPoint(p, matrix));
  if (entity.fitPoints) clone.fitPoints = entity.fitPoints.map((p) => transformPoint(p, matrix));
  if (entity.attribs) clone.attribs = entity.attribs.map((attribute) => transformEntity(attribute, matrix));
  if (entity.commands) clone.commands = transformPathCommands(entity.commands, matrix);
  if (entity.loops) {
    clone.loops = entity.loops.map((loop) => ({
      ...loop,
      vertices: loop.vertices?.map((p) => transformPoint(p, matrix)),
      commands: transformPathCommands(loop.commands, matrix)
    }));
  }

  if (typeof entity.radius === 'number' && Number.isFinite(scaleApprox)) clone.radius = entity.radius * scaleApprox;
  if (typeof entity.constantWidth === 'number' && Number.isFinite(scaleApprox)) clone.constantWidth = entity.constantWidth * scaleApprox;
  if (typeof entity.thickness === 'number' && Number.isFinite(scaleApprox)) clone.thickness = entity.thickness * scaleApprox;
  if (typeof entity.lineTypeScale === 'number' && Number.isFinite(scaleApprox)) clone.lineTypeScale = entity.lineTypeScale * scaleApprox;
  if (entity.kind === 'text' || /^(TEXT|MTEXT|ATTRIB|ATTDEF|DIMENSION)$/i.test(String(entity.type ?? ''))) {
    if (typeof entity.textHeight === 'number' && Number.isFinite(scaleY)) clone.textHeight = entity.textHeight * scaleY;
    if (typeof entity.height === 'number' && Number.isFinite(scaleY)) clone.height = entity.height * scaleY;
    if (typeof entity.xScale === 'number' && scaleY > 1e-14 && Number.isFinite(scaleX)) clone.xScale = entity.xScale * scaleX / scaleY;
  }
  const rotation = Math.atan2(matrix.b, matrix.a);
  const ellipseAnglesAreRelative = entity.kind === 'ellipse' || String(entity.type ?? '').toUpperCase() === 'ELLIPSE';
  if (typeof entity.rotation === 'number' || entity.kind === 'text' || entity.kind === 'insert') {
    clone.rotation = normalizeRotation(Number(entity.rotation ?? 0) + (Number.isFinite(rotation) ? rotation : 0));
  }
  if (Number.isFinite(rotation) && Math.abs(rotation) > 1e-14) {
    // ARC angles are WCS angles and rotate with the scene. ELLIPSE start/end
    // parameters are relative to majorAxisEndPoint, which was already rotated.
    if (!ellipseAnglesAreRelative && typeof entity.startAngle === 'number') clone.startAngle = entity.startAngle + rotation;
    if (!ellipseAnglesAreRelative && typeof entity.endAngle === 'number') clone.endAngle = entity.endAngle + rotation;
  }
  if (determinant < 0 && clone.vertices) {
    clone.vertices = clone.vertices.map((point) => ({ ...point, bulge: typeof point.bulge === 'number' ? -point.bulge : undefined }));
  }
  return clone;
}

function scaleDimension(value: number | undefined, scale: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(scale) ? value * scale : value;
}

function normalizeRotation(angle: number): number {
  if (!Number.isFinite(angle)) return angle;
  const tau = Math.PI * 2;
  const normalized = ((angle + Math.PI) % tau + tau) % tau - Math.PI;
  return Math.abs(normalized) <= 1e-12 ? 0 : normalized;
}

export function parseMatrix(value: string | null | undefined): Matrix2D | undefined {
  if (!value) return undefined;
  const numbers = value.match(/-?\d*\.?\d+(?:[eE][+-]?\d+)?/g)?.map(Number) ?? [];
  if (numbers.length < 6) return undefined;
  const [a, b, c, d, e, f] = numbers;
  return { a, b, c, d, e, f };
}
