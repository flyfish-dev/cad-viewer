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
  const clone: CadEntity = { ...entity, raw: entity.raw ?? entity };
  if (entity.startPoint) clone.startPoint = transformPoint(entity.startPoint, matrix);
  if (entity.endPoint) clone.endPoint = transformPoint(entity.endPoint, matrix);
  if (entity.center) clone.center = transformPoint(entity.center, matrix);
  if (entity.insertionPoint) clone.insertionPoint = transformPoint(entity.insertionPoint, matrix);
  if (entity.majorAxisEndPoint) {
    const origin = transformPoint({ x: 0, y: 0 }, matrix);
    const major = transformPoint(entity.majorAxisEndPoint, matrix);
    clone.majorAxisEndPoint = { x: major.x - origin.x, y: major.y - origin.y, z: major.z };
  }
  if (entity.vertices) clone.vertices = entity.vertices.map((p) => ({ ...transformPoint(p, matrix), bulge: p.bulge, startWidth: p.startWidth, endWidth: p.endWidth }));
  if (entity.points) clone.points = entity.points.map((p) => transformPoint(p, matrix));
  if (entity.controlPoints) clone.controlPoints = entity.controlPoints.map((p) => transformPoint(p, matrix));
  if (entity.fitPoints) clone.fitPoints = entity.fitPoints.map((p) => transformPoint(p, matrix));
  if (entity.commands) clone.commands = transformPathCommands(entity.commands, matrix);
  if (entity.loops) {
    clone.loops = entity.loops.map((loop) => ({
      ...loop,
      vertices: loop.vertices?.map((p) => transformPoint(p, matrix)),
      commands: transformPathCommands(loop.commands, matrix)
    }));
  }

  const scaleApprox = Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c));
  if (typeof entity.radius === 'number' && Number.isFinite(scaleApprox)) clone.radius = entity.radius * scaleApprox;
  return clone;
}

export function parseMatrix(value: string | null | undefined): Matrix2D | undefined {
  if (!value) return undefined;
  const numbers = value.match(/-?\d*\.?\d+(?:[eE][+-]?\d+)?/g)?.map(Number) ?? [];
  if (numbers.length < 6) return undefined;
  const [a, b, c, d, e, f] = numbers;
  return { a, b, c, d, e, f };
}
