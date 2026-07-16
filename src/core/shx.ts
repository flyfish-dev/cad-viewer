import { layoutTextRun, ShxFont } from '@mlightcad/shx-parser';
import type {
  CadLoadedReference,
  CadDocument,
  CadMissingReference,
  CadPoint2D,
  CadReferenceInput,
  CadReferenceState
} from './types';

export interface CadShxGlyph {
  polylines: ReadonlyArray<ReadonlyArray<CadPoint2D>>;
}

export interface CadShxGlyphResolver {
  resolveShape(shapeNumber: number, fontName?: string): CadShxGlyph | undefined;
  resolveText(text: string, fontName?: string): CadShxGlyph | undefined;
}

export const EMPTY_SHX_GLYPH_RESOLVER: CadShxGlyphResolver = Object.freeze({
  resolveShape: () => undefined,
  resolveText: () => undefined
});

interface LoadedShxFont {
  key: string;
  font: ShxFont;
  info: CadLoadedReference;
  shapeCache: Map<number, CadShxGlyph | null>;
  textCache: Map<string, CadShxGlyph | null>;
}

interface ShxRequirement {
  fileName?: string;
  shapeNumbers: Set<number>;
  texts: Set<string>;
}

export const COMPLEX_SHX_WARNING_PREFIX = 'Complex SHX linetype glyphs';

export class CadShxFontRegistry implements CadShxGlyphResolver {
  private readonly fonts = new Map<string, LoadedShxFont>();
  private requirements: ShxRequirement[] = [];

  async add(input: CadReferenceInput): Promise<CadLoadedReference> {
    const fileName = referenceFileName(input.fileName ?? input.file?.name);
    if (!fileName) throw new Error('A fileName is required when adding an SHX reference buffer.');
    if (!/\.shx$/i.test(fileName)) throw new Error(`${fileName} is not an SHX reference file.`);
    if (!input.file && !input.buffer) throw new Error(`No file content was provided for ${fileName}.`);

    const bytes = input.file
      ? new Uint8Array(await input.file.arrayBuffer())
      : copyBytes(input.buffer!);
    if (bytes.byteLength === 0) throw new Error(`${fileName} is empty.`);

    let font: ShxFont;
    try {
      font = new ShxFont(exactArrayBuffer(bytes));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to parse SHX reference ${fileName}: ${message}`);
    }

    const key = referenceKey(fileName);
    const previous = this.fonts.get(key);
    const info: CadLoadedReference = {
      kind: 'shx',
      fileName,
      bytes: bytes.byteLength,
      fontType: font.fontData.header.fontType,
      glyphCount: Object.keys(font.fontData.content.data).length
    };
    this.fonts.set(key, { key, font, info, shapeCache: new Map(), textCache: new Map() });
    previous?.font.release();
    return { ...info };
  }

  setDocument(document: CadDocument | undefined): void {
    if (!document) {
      this.requirements = [];
      return;
    }
    const requirements = new Map<string, ShxRequirement>();
    const add = (fileName?: string) => {
      const normalizedName = referenceFileName(fileName);
      const key = normalizedName ? referenceKey(normalizedName) : '*';
      let requirement = requirements.get(key);
      if (!requirement) {
        requirement = { fileName: normalizedName || undefined, shapeNumbers: new Set(), texts: new Set() };
        requirements.set(key, requirement);
      }
      return requirement;
    };

    for (const lineType of new Set(Object.values(document.lineTypes ?? {}))) {
      for (const element of lineType.pattern) {
        const flag = Number(element.elementTypeFlag ?? 0);
        if (flag === 0) continue;
        const requirement = add(element.fontName);
        const shapeNumber = Math.trunc(Number(element.shapeNumber));
        if ((flag & 4) === 4 && Number.isFinite(shapeNumber)) requirement.shapeNumbers.add(shapeNumber);
        if ((flag & 2) === 2 && element.text) requirement.texts.add(element.text);
      }
    }
    const declared = Array.isArray(document.metadata.requiredShxFonts)
      ? document.metadata.requiredShxFonts
      : [];
    for (const fileName of declared) add(String(fileName));
    const unknown = requirements.get('*');
    const named = [...requirements.entries()].filter(([key]) => key !== '*');
    if (unknown && named.length === 1) {
      const target = named[0][1];
      for (const shapeNumber of unknown.shapeNumbers) target.shapeNumbers.add(shapeNumber);
      for (const text of unknown.texts) target.texts.add(text);
      requirements.delete('*');
    }
    this.requirements = [...requirements.values()];
  }

  has(fileName: string): boolean {
    return this.fonts.has(referenceKey(fileName));
  }

  remove(fileName: string): boolean {
    const key = referenceKey(fileName);
    const existing = this.fonts.get(key);
    if (!existing) return false;
    existing.font.release();
    this.fonts.delete(key);
    return true;
  }

  clear(): void {
    for (const entry of this.fonts.values()) entry.font.release();
    this.fonts.clear();
  }

  getState(): CadReferenceState {
    const missing: CadMissingReference[] = [];
    for (const requirement of this.requirements) {
      if (requirement.fileName) {
        const entry = this.fonts.get(referenceKey(requirement.fileName));
        if (!entry) {
          missing.push({ kind: 'shx', fileName: requirement.fileName, identified: true, reason: 'not-loaded' });
        } else if (!fontSatisfies(entry.font, requirement)) {
          missing.push({ kind: 'shx', fileName: requirement.fileName, identified: true, reason: 'incompatible' });
        }
        continue;
      }
      const compatible = [...this.fonts.values()].some((entry) => fontSatisfies(entry.font, requirement));
      if (!compatible) {
        missing.push({ kind: 'shx', fileName: 'External SHX font', identified: false, reason: this.fonts.size ? 'incompatible' : 'not-loaded' });
      }
    }
    return {
      missing,
      loaded: [...this.fonts.values()]
        .map(({ info }) => ({ ...info }))
        .sort((left, right) => left.fileName.localeCompare(right.fileName))
    };
  }

  resolveShape(shapeNumber: number, fontName?: string): CadShxGlyph | undefined {
    const code = Math.trunc(Number(shapeNumber));
    if (!Number.isFinite(code) || code < 0) return undefined;
    const entry = this.resolveFont(fontName, (font) => font.hasChar(code));
    if (!entry) return undefined;
    const cached = entry.shapeCache.get(code);
    if (cached !== undefined) return cached ?? undefined;
    let glyph: CadShxGlyph | undefined;
    try {
      const shape = entry.font.getCharShape(code, 1);
      glyph = shape ? glyphFromPolylines(shape.polylines) : undefined;
    } catch {
      glyph = undefined;
    }
    entry.shapeCache.set(code, glyph ?? null);
    return glyph;
  }

  resolveText(text: string, fontName?: string): CadShxGlyph | undefined {
    if (!text) return undefined;
    const codes = Array.from(text, (character) => character.codePointAt(0) ?? 0);
    const entry = this.resolveFont(fontName, (font) => codes.every((code) => font.hasChar(code)));
    if (!entry) return undefined;
    const cached = entry.textCache.get(text);
    if (cached !== undefined) return cached ?? undefined;
    let glyph: CadShxGlyph | undefined;
    try {
      const placed = layoutTextRun(codes.map((code) => ({ font: entry.font, code, size: 1 })));
      glyph = glyphFromPolylines(placed.flatMap(({ shape }) => shape.polylines));
    } catch {
      glyph = undefined;
    }
    entry.textCache.set(text, glyph ?? null);
    return glyph;
  }

  private resolveFont(fontName: string | undefined, predicate: (font: ShxFont) => boolean): LoadedShxFont | undefined {
    if (fontName) {
      const exact = this.fonts.get(referenceKey(fontName));
      return exact && predicate(exact.font) ? exact : undefined;
    }

    const requiredMatches = this.requirements
      .map(({ fileName }) => fileName ? this.fonts.get(referenceKey(fileName)) : undefined)
      .filter((entry): entry is LoadedShxFont => entry !== undefined && predicate(entry.font));
    if (requiredMatches.length === 1) return requiredMatches[0];

    const matches = [...this.fonts.values()].filter((entry) => predicate(entry.font));
    return matches.length === 1 ? matches[0] : undefined;
  }
}

export function synchronizeCadDocumentReferences(document: CadDocument, state: CadReferenceState): void {
  const required = Array.isArray(document.metadata.requiredShxFonts)
    ? document.metadata.requiredShxFonts.map(String)
    : [];
  document.metadata.missingReferences = state.missing.map((reference) => ({ ...reference }));
  document.metadata.loadedReferences = state.loaded.map((reference) => ({ ...reference }));
  document.metadata.loadedShxFonts = required.filter((fileName) => state.loaded.some((loaded) => referenceKey(loaded.fileName) === referenceKey(fileName)));

  for (let index = document.warnings.length - 1; index >= 0; index--) {
    if (document.warnings[index].startsWith(COMPLEX_SHX_WARNING_PREFIX)) document.warnings.splice(index, 1);
  }
  if (state.missing.length === 0) return;
  const names = state.missing.map(({ fileName, reason }) => reason === 'incompatible' ? `${fileName} (missing required glyphs)` : fileName);
  document.warnings.push(`${COMPLEX_SHX_WARNING_PREFIX} are using a dash/dot fallback until the missing reference${names.length === 1 ? ' is' : 's are'} supplied: ${names.join(', ')}.`);
}

export function referenceFileName(value: string | undefined): string {
  return String(value ?? '').trim().split(/[\\/]/).filter(Boolean).pop() ?? '';
}

export function referenceKey(value: string): string {
  return referenceFileName(value).toLocaleLowerCase('en-US');
}

function glyphFromPolylines(polylines: ReadonlyArray<ReadonlyArray<CadPoint2D>>): CadShxGlyph | undefined {
  const normalized = polylines
    .map((polyline) => polyline
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      .map((point) => ({ x: point.x, y: point.y })))
    .filter((polyline) => polyline.length >= 2);
  return normalized.length > 0 ? { polylines: normalized } : undefined;
}

function fontSatisfies(font: ShxFont, requirement: ShxRequirement): boolean {
  for (const shapeNumber of requirement.shapeNumbers) if (!font.hasChar(shapeNumber)) return false;
  for (const text of requirement.texts) {
    for (const character of text) if (!font.hasChar(character.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

function copyBytes(buffer: ArrayBuffer | Uint8Array): Uint8Array {
  return buffer instanceof Uint8Array ? buffer.slice() : new Uint8Array(buffer.slice(0));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
