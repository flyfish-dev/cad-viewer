import { unzipSync } from 'fflate';
import { createCadDocument, flattenPages } from '../../core/entity';
import { normalizeXpsColor } from '../../core/color';
import { decodeUtf8, detectCadFormat, extensionOf, readInputBytes } from '../../core/format';
import { emptyBounds, includePoint } from '../../core/geometry';
import { IDENTITY_MATRIX, multiplyMatrix, parseMatrix, transformPoint, type Matrix2D } from '../../core/transform';
import type { CadDocument, CadEntity, CadLoadInput, CadLoadOptions, CadLoadResult, CadLoader, CadPage, CadPathCommand, CadPoint2D } from '../../core/types';

export class DwfUnsupportedError extends Error {
  readonly format = 'dwf';
  constructor(message: string) {
    super(message);
    this.name = 'DwfUnsupportedError';
  }
}

export class DwfLoader implements CadLoader {
  readonly id = 'dwf';
  readonly label = 'DWFx/XPS 2D package loader';
  readonly formats = ['dwf', 'dwfx', 'xps'] as const;
  private readonly defaults: CadLoadOptions;

  constructor(defaults: CadLoadOptions = {}) {
    this.defaults = defaults;
  }

  accepts(input: CadLoadInput, bytes?: Uint8Array): boolean {
    const ext = extensionOf(input);
    if (ext === 'dwf' || ext === 'dwfx' || ext === 'xps') return true;
    const format = detectCadFormat(input, bytes);
    return format === 'dwf' || format === 'dwfx' || format === 'xps';
  }

  async load(input: CadLoadInput, options: CadLoadOptions = {}): Promise<CadLoadResult> {
    void { ...this.defaults, ...options };
    const started = performance.now();
    const bytes = await readInputBytes(input);
    const sourceName = input.fileName ?? input.file?.name;
    const ext = extensionOf(input);
    const packageFiles = openZipPackage(bytes);
    const pages = parseXpsPages(packageFiles, sourceName);

    if (pages.length === 0) {
      const entries = Object.keys(packageFiles);
      const hasWhip = entries.some((name) => /\.(w2d|w3d|whip)$/i.test(name));
      const hasDwfManifest = entries.some((name) => /manifest|descriptor|eplot/i.test(name));
      if (hasWhip || ext === 'dwf' || hasDwfManifest) {
        throw new DwfUnsupportedError('Classic DWF packages usually store geometry in WHIP/W2D/W3D streams. This browser build detects them but does not decode the full classic DWF graphics stream without a DWF Toolkit/WASM implementation. DWFx/XPS 2D pages are supported.');
      }
      throw new DwfUnsupportedError('No FixedPage/XPS content found in this DWF/DWFx package.');
    }

    const warnings: string[] = [];
    if (ext === 'dwf') warnings.push('This .dwf package contained XPS/FixedPage-compatible content and was rendered through the DWFx loader path. Classic WHIP/W2D streams are not decoded.');
    const document = createCadDocument({
      format: ext === 'dwf' ? 'dwf' : ext === 'xps' ? 'xps' : 'dwfx',
      sourceName,
      layers: {},
      blocks: {},
      pages,
      entities: flattenPages(pages),
      metadata: {
        parser: 'cad-viewer DWFx/XPS loader',
        packageEntries: Object.keys(packageFiles).length
      },
      warnings,
      raw: { entries: Object.keys(packageFiles) }
    });
    const elapsedMs = performance.now() - started;
    return { document, raw: document.raw, bytes: bytes.byteLength, elapsedMs, format: document.format, warnings: document.warnings };
  }
}

function openZipPackage(bytes: Uint8Array): Record<string, Uint8Array> {
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    throw new DwfUnsupportedError('DWF/DWFx loader expects a ZIP/OPC package. Non-ZIP classic DWF streams require a dedicated WHIP decoder.');
  }
  return unzipSync(bytes);
}

function parseXpsPages(files: Record<string, Uint8Array>, sourceName?: string): CadPage[] {
  const pageEntries = Object.entries(files)
    .filter(([name, data]) => /\.fpage$/i.test(name) || decodeUtf8(data.slice(0, Math.min(512, data.byteLength))).includes('<FixedPage'))
    .sort(([a], [b]) => a.localeCompare(b));

  const pages: CadPage[] = [];
  for (const [name, data] of pageEntries) {
    const xml = decodeUtf8(data);
    if (!xml.includes('<FixedPage')) continue;
    const page = parseFixedPage(xml, pages.length, name, files, sourceName);
    if (page) pages.push(page);
  }
  return pages;
}

function parseFixedPage(xml: string, index: number, name: string, files: Record<string, Uint8Array>, sourceName?: string): CadPage | undefined {
  if (typeof DOMParser === 'undefined') {
    throw new Error('DWFx/XPS parsing requires DOMParser. Use it in a browser environment or provide a DOMParser polyfill.');
  }
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (!root || !/FixedPage$/i.test(root.nodeName)) return undefined;
  const width = numberAttr(root, 'Width') ?? 1000;
  const height = numberAttr(root, 'Height') ?? 1000;
  const entities: CadEntity[] = [];

  walkElement(root, IDENTITY_MATRIX, (element, matrix) => {
    const localMatrix = multiplyMatrix(matrix, parseElementTransform(element) ?? IDENTITY_MATRIX);
    const tag = stripNamespace(element.nodeName);
    if (tag === 'Path') {
      const pathEntity = parsePathElement(element, localMatrix, height, index);
      if (pathEntity) entities.push(pathEntity);
    } else if (tag === 'Glyphs') {
      const textEntity = parseGlyphsElement(element, localMatrix, height, index);
      if (textEntity) entities.push(textEntity);
    } else if (tag === 'Canvas') {
      // Children are visited by walkElement with the accumulated transform.
    } else if (tag === 'ImageBrush') {
      const image = parseImageBrushElement(element, localMatrix, height, index, name, files);
      if (image) entities.push(image);
    }
    return localMatrix;
  });

  return { index, name: sourceName ? `${sourceName} / ${name}` : name, width, height, entities };
}

function walkElement(element: Element, matrix: Matrix2D, visitor: (element: Element, matrix: Matrix2D) => Matrix2D): void {
  const local = visitor(element, matrix);
  for (const child of Array.from(element.children)) walkElement(child, local, visitor);
}

function parsePathElement(element: Element, matrix: Matrix2D, pageHeight: number, pageIndex: number): CadEntity | undefined {
  const data = element.getAttribute('Data') ?? findGeometryData(element);
  if (!data) return undefined;
  const commands = parseXpsPathData(data)
    .map((command) => ({
      cmd: command.cmd,
      points: command.points.map((p) => pageToCadPoint(transformPoint(p, matrix), pageHeight))
    }));
  if (!commands.length) return undefined;

  const stroke = normalizeXpsColor(element.getAttribute('Stroke') ?? undefined);
  const fill = normalizeXpsColor(element.getAttribute('Fill') ?? undefined);
  const opacity = numberAttr(element, 'Opacity');
  return {
    type: 'XPS_PATH',
    kind: 'path',
    commands,
    color: stroke ?? fill ?? '#ffffff',
    fillColor: fill,
    lineweight: numberAttr(element, 'StrokeThickness') ?? 1,
    opacity,
    pageIndex,
    raw: element.outerHTML
  };
}

function parseGlyphsElement(element: Element, matrix: Matrix2D, pageHeight: number, pageIndex: number): CadEntity | undefined {
  const text = element.getAttribute('UnicodeString') ?? element.getAttribute('Indices') ?? '';
  if (!text) return undefined;
  const origin = { x: numberAttr(element, 'OriginX') ?? 0, y: numberAttr(element, 'OriginY') ?? 0 };
  const p = pageToCadPoint(transformPoint(origin, matrix), pageHeight);
  return {
    type: 'DWF_TEXT',
    kind: 'text',
    insertionPoint: p,
    text,
    textHeight: numberAttr(element, 'FontRenderingEmSize') ?? 12,
    color: normalizeXpsColor(element.getAttribute('Fill') ?? undefined) ?? '#ffffff',
    opacity: numberAttr(element, 'Opacity'),
    pageIndex,
    raw: element.outerHTML
  };
}

function parseImageBrushElement(element: Element, matrix: Matrix2D, pageHeight: number, pageIndex: number, pageName: string, files: Record<string, Uint8Array>): CadEntity | undefined {
  const src = element.getAttribute('ImageSource');
  if (!src) return undefined;
  const viewport = element.getAttribute('Viewport')?.match(/-?\d*\.?\d+(?:[eE][+-]?\d+)?/g)?.map(Number) ?? [];
  const x = viewport[0] ?? 0;
  const y = viewport[1] ?? 0;
  const w = viewport[2] ?? 32;
  const h = viewport[3] ?? 32;
  const p = pageToCadPoint(transformPoint({ x, y }, matrix), pageHeight);
  const imageName = resolvePackagePath(pageName, src);
  const data = files[imageName.replace(/^\//, '')] ?? files[imageName];
  return {
    type: 'DWF_IMAGE',
    kind: 'image',
    insertionPoint: p,
    width: w,
    height: h,
    imageSource: src,
    imageDataUrl: data ? bytesToDataUrl(data, imageName) : undefined,
    pageIndex,
    raw: element.outerHTML
  };
}

function parseXpsPathData(data: string): CadPathCommand[] {
  const tokens = data.match(/[AaCcHhLlMmQqSsVvZz]|-?\d*\.?\d+(?:[eE][+-]?\d+)?/g) ?? [];
  const out: CadPathCommand[] = [];
  let i = 0;
  let cmd = '';
  let current: CadPoint2D = { x: 0, y: 0 };
  let subpathStart: CadPoint2D = { x: 0, y: 0 };
  const isCommand = (token: string) => /^[A-Za-z]$/.test(token);
  const read = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (isCommand(tokens[i])) cmd = tokens[i++];
    if (!cmd) break;
    const relative = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();
    if (upper === 'Z') {
      out.push({ cmd: 'Z', points: [] });
      current = { ...subpathStart };
      cmd = '';
      continue;
    }
    if (upper === 'M') {
      const x = read(); const y = read();
      if (!Number.isFinite(x) || !Number.isFinite(y)) break;
      current = makePoint(x, y, relative, current);
      subpathStart = { ...current };
      out.push({ cmd: 'M', points: [current] });
      cmd = relative ? 'l' : 'L';
      continue;
    }
    if (upper === 'L') {
      const x = read(); const y = read();
      if (!Number.isFinite(x) || !Number.isFinite(y)) break;
      current = makePoint(x, y, relative, current);
      out.push({ cmd: 'L', points: [current] });
      continue;
    }
    if (upper === 'H') {
      const x = read();
      if (!Number.isFinite(x)) break;
      current = { x: relative ? current.x + x : x, y: current.y };
      out.push({ cmd: 'L', points: [current] });
      continue;
    }
    if (upper === 'V') {
      const y = read();
      if (!Number.isFinite(y)) break;
      current = { x: current.x, y: relative ? current.y + y : y };
      out.push({ cmd: 'L', points: [current] });
      continue;
    }
    if (upper === 'C') {
      const p1 = makePoint(read(), read(), relative, current);
      const p2 = makePoint(read(), read(), relative, current);
      const p3 = makePoint(read(), read(), relative, current);
      if (![p1.x, p1.y, p2.x, p2.y, p3.x, p3.y].every(Number.isFinite)) break;
      current = p3;
      out.push({ cmd: 'C', points: [p1, p2, p3] });
      continue;
    }
    if (upper === 'Q' || upper === 'S') {
      const p1 = makePoint(read(), read(), relative, current);
      const p2 = makePoint(read(), read(), relative, current);
      if (![p1.x, p1.y, p2.x, p2.y].every(Number.isFinite)) break;
      current = p2;
      out.push({ cmd: 'Q', points: [p1, p2] });
      continue;
    }
    if (upper === 'A') {
      // XPS/SVG elliptical arc: rx ry xrot largeArc sweep x y. Canvas renderer approximates it as a line to the endpoint.
      read(); read(); read(); read(); read();
      const end = makePoint(read(), read(), relative, current);
      if (![end.x, end.y].every(Number.isFinite)) break;
      current = end;
      out.push({ cmd: 'L', points: [end] });
      continue;
    }
    break;
  }
  return out;
}

function makePoint(x: number, y: number, relative: boolean, current: CadPoint2D): CadPoint2D {
  return relative ? { x: current.x + x, y: current.y + y } : { x, y };
}

function pageToCadPoint(point: CadPoint2D, pageHeight: number): CadPoint2D {
  return { x: point.x, y: pageHeight - point.y };
}

function findGeometryData(element: Element): string | undefined {
  for (const child of Array.from(element.children)) {
    if (/PathGeometry$/i.test(child.nodeName)) {
      const figures = child.getAttribute('Figures');
      if (figures) return figures;
    }
  }
  return undefined;
}

function parseElementTransform(element: Element): Matrix2D | undefined {
  return parseMatrix(element.getAttribute('RenderTransform'))
    ?? parseMatrix(element.getAttribute('Transform'))
    ?? parseChildMatrix(element, 'RenderTransform')
    ?? parseChildMatrix(element, 'Canvas.RenderTransform')
    ?? parseChildMatrix(element, 'Path.RenderTransform')
    ?? parseChildMatrix(element, 'Glyphs.RenderTransform');
}

function parseChildMatrix(element: Element, tag: string): Matrix2D | undefined {
  for (const child of Array.from(element.children)) {
    if (stripNamespace(child.nodeName) !== tag && child.nodeName !== tag) continue;
    const matrix = child.textContent ? parseMatrix(child.textContent) : undefined;
    if (matrix) return matrix;
    for (const nested of Array.from(child.children)) {
      const candidate = parseMatrix(nested.getAttribute('Matrix') ?? nested.textContent ?? undefined);
      if (candidate) return candidate;
    }
  }
  return undefined;
}

function numberAttr(element: Element, name: string): number | undefined {
  const value = element.getAttribute(name);
  const n = value === null ? NaN : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function stripNamespace(name: string): string {
  return name.includes(':') ? name.split(':').pop() ?? name : name;
}

function resolvePackagePath(baseFile: string, relative: string): string {
  if (relative.startsWith('/')) return relative.slice(1);
  const dir = baseFile.includes('/') ? baseFile.slice(0, baseFile.lastIndexOf('/') + 1) : '';
  const stack = `${dir}${relative}`.split('/');
  const out: string[] = [];
  for (const part of stack) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function bytesToDataUrl(bytes: Uint8Array, name: string): string {
  const mime = /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : 'image/png';
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mime};base64,${btoa(binary)}`;
}
