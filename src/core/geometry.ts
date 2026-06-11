import type { CadBounds, CadPoint2D, CadPoint3D } from './types';

export function emptyBounds(): CadBounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function boundsValid(bounds: CadBounds): boolean {
  return Number.isFinite(bounds.minX) && Number.isFinite(bounds.minY) && Number.isFinite(bounds.maxX) && Number.isFinite(bounds.maxY)
    && bounds.maxX >= bounds.minX && bounds.maxY >= bounds.minY;
}

export function includePoint(bounds: CadBounds, point: CadPoint2D | CadPoint3D): void {
  if (!isFinitePoint(point)) return;
  bounds.minX = Math.min(bounds.minX, point.x);
  bounds.minY = Math.min(bounds.minY, point.y);
  bounds.maxX = Math.max(bounds.maxX, point.x);
  bounds.maxY = Math.max(bounds.maxY, point.y);
}

export function includeCircle(bounds: CadBounds, center: CadPoint2D, radius: number): void {
  if (!isFinitePoint(center) || !Number.isFinite(radius)) return;
  const r = Math.abs(radius);
  includePoint(bounds, { x: center.x - r, y: center.y - r });
  includePoint(bounds, { x: center.x + r, y: center.y + r });
}

export function mergeBounds(target: CadBounds, source: CadBounds): void {
  if (!boundsValid(source)) return;
  includePoint(target, { x: source.minX, y: source.minY });
  includePoint(target, { x: source.maxX, y: source.maxY });
}

export function paddedBounds(bounds: CadBounds, ratio = 0.02, minimum = 1e-6): CadBounds {
  if (!boundsValid(bounds)) return { minX: -10, minY: -10, maxX: 10, maxY: 10 };
  const padX = Math.max((bounds.maxX - bounds.minX) * ratio, minimum);
  const padY = Math.max((bounds.maxY - bounds.minY) * ratio, minimum);
  return { minX: bounds.minX - padX, minY: bounds.minY - padY, maxX: bounds.maxX + padX, maxY: bounds.maxY + padY };
}

export function isFinitePoint(p: unknown): p is CadPoint3D {
  return !!p && typeof p === 'object'
    && Number.isFinite((p as CadPoint2D).x)
    && Number.isFinite((p as CadPoint2D).y);
}

export function xy(p: CadPoint2D | CadPoint3D): CadPoint2D {
  return { x: p.x, y: p.y };
}

export function normalizeAngleRadians(value: number): number {
  let out = value;
  while (out < 0) out += Math.PI * 2;
  while (out >= Math.PI * 2) out -= Math.PI * 2;
  return out;
}

export function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

export function arcPoints(center: CadPoint2D, radius: number, startAngle: number, endAngle: number, ccw = true, segments = 64): CadPoint2D[] {
  if (!isFinitePoint(center) || !Number.isFinite(radius)) return [];
  let start = startAngle;
  let end = endAngle;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];

  if (Math.abs(start) > Math.PI * 2 + 1e-6 || Math.abs(end) > Math.PI * 2 + 1e-6) {
    start = degreesToRadians(start);
    end = degreesToRadians(end);
  }

  if (ccw && end < start) end += Math.PI * 2;
  if (!ccw && start < end) start += Math.PI * 2;
  const sweep = end - start;
  const count = Math.max(8, Math.min(256, Math.ceil(Math.abs(sweep) / (Math.PI * 2) * segments)));
  const pts: CadPoint2D[] = [];
  for (let i = 0; i <= count; i++) {
    const t = start + sweep * (i / count);
    pts.push({ x: center.x + Math.cos(t) * radius, y: center.y + Math.sin(t) * radius });
  }
  return pts;
}

export function ellipsePoints(center: CadPoint2D, majorAxisEndPoint: CadPoint2D, ratio = 1, startAngle = 0, endAngle = Math.PI * 2, segments = 96): CadPoint2D[] {
  if (!isFinitePoint(center) || !isFinitePoint(majorAxisEndPoint)) return [];
  const major = Math.hypot(majorAxisEndPoint.x, majorAxisEndPoint.y);
  if (!Number.isFinite(major) || major <= 0) return [];
  const minor = major * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
  const rotation = Math.atan2(majorAxisEndPoint.y, majorAxisEndPoint.x);
  let start = Number.isFinite(startAngle) ? startAngle : 0;
  let end = Number.isFinite(endAngle) ? endAngle : Math.PI * 2;
  if (Math.abs(start) > Math.PI * 2 + 1e-6 || Math.abs(end) > Math.PI * 2 + 1e-6) {
    start = degreesToRadians(start);
    end = degreesToRadians(end);
  }
  if (end < start) end += Math.PI * 2;
  const count = Math.max(12, Math.min(256, Math.ceil(Math.abs(end - start) / (Math.PI * 2) * segments)));
  const pts: CadPoint2D[] = [];
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  for (let i = 0; i <= count; i++) {
    const t = start + (end - start) * (i / count);
    const x = Math.cos(t) * major;
    const y = Math.sin(t) * minor;
    pts.push({ x: center.x + x * cosR - y * sinR, y: center.y + x * sinR + y * cosR });
  }
  return pts;
}

export function bulgeToPolylinePoints(p1: CadPoint2D, p2: CadPoint2D, bulge = 0, segments = 16): CadPoint2D[] {
  if (!Number.isFinite(bulge) || Math.abs(bulge) < 1e-12) return [xy(p1), xy(p2)];
  const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (chord <= 1e-12) return [xy(p1), xy(p2)];
  const theta = 4 * Math.atan(bulge);
  const radius = Math.abs(chord / (2 * Math.sin(theta / 2)));
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const dx = (p2.x - p1.x) / chord;
  const dy = (p2.y - p1.y) / chord;
  const sagittaDirection = bulge >= 0 ? 1 : -1;
  const h = Math.sqrt(Math.max(radius * radius - (chord / 2) ** 2, 0));
  const center = { x: mid.x - sagittaDirection * dy * h, y: mid.y + sagittaDirection * dx * h };
  const a1 = Math.atan2(p1.y - center.y, p1.x - center.x);
  const a2 = Math.atan2(p2.y - center.y, p2.x - center.x);
  return arcPoints(center, radius, a1, a2, bulge >= 0, segments);
}

export function stripMTextFormatting(text: string): string {
  return text
    .replace(/\\P/g, '\n')
    .replace(/\\~|\\ /g, ' ')
    .replace(/\\[A-Za-z][^;]*;/g, '')
    .replace(/[{}]/g, '')
    .replace(/\\[A-Za-z]/g, '')
    .trim();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
