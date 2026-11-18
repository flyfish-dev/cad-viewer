import type { CadBounds, CadEntity, CadPoint2D } from './types.js';

const DEFAULT_FONT = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MEASURE_SIZE = 100;

export interface CadTextStyle {
  height: number;
  width: number;
  font: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  overline: boolean;
  strike: boolean;
}

export interface CadTextRun { text: string; style: CadTextStyle }
export interface CadTextParagraph { runs: CadTextRun[]; align: 'left' | 'center' | 'right' }
export interface ParsedCadText { text: string; paragraphs: CadTextParagraph[] }

/** Decode exactly one UTF-16 code unit, without reinterpreting escaped backslashes. */
export function decodeCadUnicodeEscapes(text: string): string {
  return text.replace(/\\\\|\\U\+([0-9a-f]{4})/gi, (match, hex: string | undefined) => hex ? String.fromCharCode(parseInt(hex, 16)) : match);
}

/**
 * A single-pass scanner: escaped literals are never parsed a second time, and
 * only recognized, terminated controls consume parameters. In particular, a
 * Unicode escape cannot eat text up to a later semicolon or expose its hex digits.
 */
export function parseCadText(text: string, multiline = true, nominalHeight = 1, fontFamily?: string, styleWidthFactor = 1): ParsedCadText {
  const initialWidth = Number.isFinite(styleWidthFactor) && styleWidthFactor > 0 ? styleWidthFactor : 1;
  let style: CadTextStyle = { height: 1, width: initialWidth, font: safeFont(fontFamily), bold: false, italic: false, underline: false, overline: false, strike: false };
  const stack: CadTextStyle[] = [];
  let excessGroupDepth = 0;
  let excessGroupStyle: CadTextStyle | undefined;
  const paragraphs: CadTextParagraph[] = [{ runs: [], align: 'left' }];
  let paragraph = paragraphs[0];
  let buffer = '';
  const flush = () => {
    if (buffer) paragraph.runs.push({ text: buffer, style: { ...style } });
    buffer = '';
  };
  const newline = () => {
    flush();
    paragraph = { runs: [], align: paragraph.align };
    paragraphs.push(paragraph);
  };
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      newline(); i++; continue;
    }
    if (char === '%' && text[i + 1] === '%') {
      const code = text[i + 2]?.toLowerCase();
      const symbol = code === 'd' ? '°' : code === 'p' ? '±' : code === 'c' ? '∅' : code === '%' ? '%' : undefined;
      if (symbol !== undefined) { buffer += symbol; i += 3; continue; }
      if (code === 'u' || code === 'o') { flush(); style = { ...style, [code === 'u' ? 'underline' : 'overline']: !style[code === 'u' ? 'underline' : 'overline'] }; i += 3; continue; }
      const numeric = text.slice(i + 2, i + 5);
      if (/^\d{3}$/.test(numeric)) { buffer += String.fromCharCode(Number(numeric)); i += 5; continue; }
    }
    if (multiline && (char === '{' || char === '}')) {
      flush();
      if (char === '{') {
        // AutoCAD supports eight nested groups. Balance malformed deeper input
        // with a counter instead of allocating a style object per opening brace.
        if (stack.length < 8 && excessGroupDepth === 0) stack.push({ ...style });
        else { if (excessGroupDepth === 0) excessGroupStyle = { ...style }; excessGroupDepth++; }
      } else if (excessGroupDepth > 0) {
        if (--excessGroupDepth === 0 && excessGroupStyle) style = excessGroupStyle;
      } else if (stack.length) style = stack.pop()!;
      i++; continue;
    }
    if (char !== '\\' || i + 1 >= text.length) { buffer += char; i++; continue; }
    const code = text[i + 1];
    if (code === '\\') { buffer += '\\'; i += 2; continue; }
    if ((code === 'U' || code === 'u') && text[i + 2] === '+' && /^[0-9a-f]{4}$/i.test(text.slice(i + 3, i + 7))) {
      buffer += String.fromCharCode(parseInt(text.slice(i + 3, i + 7), 16)); i += 7; continue;
    }
    if (!multiline) { buffer += char; i++; continue; }
    if (code === '{' || code === '}') { buffer += code; i += 2; continue; }
    if (code === '~' || code === ' ') { buffer += code === '~' ? '\u00a0' : ' '; i += 2; continue; }
    if (code === 'P' || code === 'X') { newline(); i += 2; continue; }
    if ('LlOoKk'.includes(code)) {
      flush();
      const key = code.toLowerCase() === 'l' ? 'underline' : code.toLowerCase() === 'o' ? 'overline' : 'strike';
      style = { ...style, [key]: code === code.toUpperCase() };
      i += 2; continue;
    }
    if ('AaCcFfHhQqTtWwSsp'.includes(code)) {
      const end = controlTerminator(text, i + 2);
      // Do not consume a following control/paragraph when a parameter is malformed.
      const parameter = end >= 0 ? text.slice(i + 2, end) : '';
      if (end >= 0) {
        if ('AaCcHhQqTtWw'.includes(code) && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?x?$/i.test(parameter)) {
          buffer += text.slice(i, end + 1); i = end + 1; continue;
        }
        flush();
        if (code === 'S' || code === 's') buffer += parameter.replace(/[\^#]/g, '/');
        else if (code === 'H' || code === 'h') {
          const relative = /x$/i.test(parameter);
          const value = Number(relative ? parameter.slice(0, -1) : parameter);
          const next = relative ? style.height * value : value / Math.max(1e-9, Math.abs(nominalHeight));
          if (Number.isFinite(next) && next > 0 && next <= 1000) style = { ...style, height: next };
        } else if (code === 'W' || code === 'w') {
          const relative = /x$/i.test(parameter);
          const value = Number(relative ? parameter.slice(0, -1) : parameter) * (relative ? initialWidth : 1);
          if (Number.isFinite(value) && value > 0 && value <= 1000) style = { ...style, width: value };
        } else if (code === 'F' || code === 'f') {
          const [font, ...flags] = parameter.split('|');
          style = { ...style, font: safeFont(font), bold: flags.includes('b1'), italic: flags.includes('i1') };
        } else if (code === 'p') {
          const alignment = parameter.match(/q([lcr])/);
          if (alignment) paragraph.align = alignment[1] === 'c' ? 'center' : alignment[1] === 'r' ? 'right' : 'left';
        }
        i = end + 1; continue;
      }
    }
    // Unknown/malformed sequences are content, not a license to discard text.
    buffer += char; i++;
  }
  flush();
  return { text: paragraphs.map((p) => p.runs.map((run) => run.text).join('')).join('\n'), paragraphs };
}

function safeFont(value?: string): string {
  if (!value || /\.shx$/i.test(value)) return DEFAULT_FONT;
  // Font names are data, not arbitrary CSS font declarations.
  const name = value.replace(/["\\\r\n\u0000-\u001f]/g, '').trim();
  return name ? `"${name}", ${DEFAULT_FONT}` : DEFAULT_FONT;
}

function controlTerminator(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === ';') return i;
    if ('\\\r\n{}'.includes(text[i])) return -1;
  }
  return -1;
}

export interface CadTextFragment { text: string; x: number; width: number; style: CadTextStyle }
export interface CadTextLine { fragments: CadTextFragment[]; width: number; height: number; y: number }
export interface CadTextLayout { lines: CadTextLine[]; width: number; height: number; offsetX: number; offsetY: number; multiline: boolean }
type TextContext = Pick<CanvasRenderingContext2D, 'font' | 'measureText'>;

/** Layout in multiples of nominal text height, independent of zoom and DPR. */
export function layoutCadText(context: TextContext, entity: CadEntity, parsed?: ParsedCadText): CadTextLayout {
  const multiline = String(entity.type).toUpperCase() === 'MTEXT';
  const height = Math.abs(Number(entity.textHeight ?? entity.height ?? 1)) || 1;
  const data = parsed ?? parseCadText(String(entity.rawText ?? entity.text ?? entity.value ?? ''), multiline, height, entity.fontFamily, multiline ? entity.textStyleWidthFactor : 1);
  const xScale = textWidthScale(entity);
  const authoredWidth = Number(entity.width);
  const maxWidth = multiline && Number.isFinite(authoredWidth) && authoredWidth > 0 ? authoredWidth / height / xScale : Infinity;
  const spacingFactor = Number(entity.lineSpacingFactor ?? 1);
  const lineSpacing = multiline ? 5 / 3 * (Number.isFinite(spacingFactor) && spacingFactor >= 0.25 && spacingFactor <= 4 ? spacingFactor : 1) : 1.22;
  const exactSpacing = Number(entity.lineSpacingStyle) === 2;
  const lines: CadTextLine[] = [];
  const cache = new Map<string, number>();
  const measure = (text: string, style: CadTextStyle) => {
    const font = fontString(style);
    const key = `${font}\0${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      context.font = font;
      width = context.measureText(text).width / MEASURE_SIZE;
      cache.set(key, width);
    }
    return width * style.width;
  };
  for (const paragraph of data.paragraphs) {
    let line: CadTextLine = { fragments: [], width: 0, height: 1, y: 0 };
    let continuation = false;
    const finish = () => {
      while (line.fragments.length && /^[ \t]+$/.test(line.fragments[line.fragments.length - 1].text)) {
        line.width -= line.fragments.pop()!.width;
      }
      if (Number.isFinite(maxWidth)) {
        const shift = paragraph.align === 'center' ? (maxWidth - line.width) / 2 : paragraph.align === 'right' ? maxWidth - line.width : 0;
        for (const fragment of line.fragments) fragment.x += shift;
      }
      lines.push(line);
      line = { fragments: [], width: 0, height: 1, y: 0 };
      continuation = true;
    };
    const add = (text: string, style: CadTextStyle, width: number) => {
      line.fragments.push({ text, x: line.width, width, style });
      line.width += width;
      line.height = Math.max(line.height, style.height);
    };
    for (const run of paragraph.runs) {
      // Keep Latin words together; CJK text can wrap without inserted spaces.
      const tokens = multiline ? run.text.match(/[ \t]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^ \t\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [] : [run.text];
      for (const token of tokens) {
        const width = measure(token, run.style);
        if (line.width > 0 && line.width + width > maxWidth + 1e-8) finish();
        if (continuation && !line.fragments.length && /^[ \t]+$/.test(token)) continue;
        if (width <= maxWidth || !Number.isFinite(maxWidth) || token.includes('\u00a0')) { add(token, run.style, width); continue; }
        // A long unbroken identifier must make progress even in a narrow box.
        for (const char of token) {
          const charWidth = measure(char, run.style);
          if (line.width > 0 && line.width + charWidth > maxWidth + 1e-8) finish();
          add(char, run.style, charWidth);
        }
      }
    }
    finish();
  }
  let y = 0;
  for (let i = 0; i < lines.length; i++) {
    lines[i].y = y;
    if (i + 1 < lines.length) y += exactSpacing ? lineSpacing : Math.max(lineSpacing, lines[i].height * lineSpacing);
  }
  const blockHeight = lines.length ? y + lines[lines.length - 1].height : 0;
  const width = Number.isFinite(maxWidth) ? maxWidth : lines.reduce((maximum, line) => Math.max(maximum, line.width), 0);
  const attachment = Math.trunc(Number(entity.attachmentPoint ?? 1));
  const validAttachment = attachment >= 1 && attachment <= 9 ? attachment : 1;
  const offsetX = multiline ? -((validAttachment - 1) % 3) * width / 2 : 0;
  const offsetY = multiline ? -Math.floor((validAttachment - 1) / 3) * blockHeight / 2 : 0;
  return { lines, width, height: blockHeight, offsetX, offsetY, multiline };
}

function fontString(style: CadTextStyle): string {
  return `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${MEASURE_SIZE * style.height}px ${style.font}`;
}

function textWidthScale(entity: CadEntity): number {
  const scale = Math.abs(Number(entity.xScale ?? 1));
  return Number.isFinite(scale) && scale > 1e-9 ? scale : 1;
}

/** World bounds from the measured lines, including alignment, rotation and mirroring. */
export function cadTextLayoutBounds(entity: CadEntity, layout: CadTextLayout, point: CadPoint2D): CadBounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, padding = 0;
  const horizontal = Number(entity.halign ?? 0);
  const vertical = Number(entity.valign ?? 0);
  for (const line of layout.lines) {
    const shift = layout.multiline ? 0 : horizontal === 1 || horizontal === 4 ? -line.width / 2 : horizontal === 2 ? -line.width : 0;
    for (const fragment of line.fragments) {
      const height = fragment.style.height;
      const top = layout.multiline || vertical === 3 ? 0 : vertical === 2 ? -height / 2 : -height;
      minX = Math.min(minX, layout.offsetX + shift + fragment.x);
      maxX = Math.max(maxX, layout.offsetX + shift + fragment.x + fragment.width);
      minY = Math.min(minY, layout.offsetY + line.y + top);
      maxY = Math.max(maxY, layout.offsetY + line.y + top + height);
      // Glyph overhangs and descenders can extend beyond their advance box.
      padding = Math.max(padding, height * 0.3);
    }
  }
  if (!Number.isFinite(minX)) return { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
  const height = Math.abs(Number(entity.textHeight ?? entity.height ?? 1)) || 1;
  const flags = Number(entity.generationFlag ?? 0);
  const sx = height * textWidthScale(entity) * (flags & 2 ? -1 : 1);
  const sy = -height * (flags & 4 ? -1 : 1);
  const angle = Number(entity.rotation ?? 0);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const x of [minX - padding, maxX + padding]) for (const y of [minY - padding, maxY + padding]) {
    const worldX = point.x + x * sx * cos - y * sy * sin;
    const worldY = point.y + x * sx * sin + y * sy * cos;
    bounds.minX = Math.min(bounds.minX, worldX); bounds.maxX = Math.max(bounds.maxX, worldX);
    bounds.minY = Math.min(bounds.minY, worldY); bounds.maxY = Math.max(bounds.maxY, worldY);
  }
  return bounds;
}

/** Both renderer backends use the same layout and painting path. */
export function paintCadText(context: CanvasRenderingContext2D, entity: CadEntity, pixelHeight: number, layout?: CadTextLayout): CadTextLayout {
  const result = layout ?? layoutCadText(context, entity);
  const horizontal = Number(entity.halign ?? 0);
  const vertical = Number(entity.valign ?? 0);
  context.textAlign = 'left';
  context.textBaseline = result.multiline ? 'top' : vertical === 1 ? 'bottom' : vertical === 2 ? 'middle' : vertical === 3 ? 'top' : 'alphabetic';
  for (const line of result.lines) {
    const textOffset = result.multiline ? 0 : horizontal === 1 || horizontal === 4 ? -line.width / 2 : horizontal === 2 ? -line.width : 0;
    for (const fragment of line.fragments) {
      const x = (result.offsetX + textOffset + fragment.x) * pixelHeight;
      const y = (result.offsetY + line.y) * pixelHeight;
      context.save();
      context.translate(x, y);
      context.scale(pixelHeight / MEASURE_SIZE * fragment.style.width, pixelHeight / MEASURE_SIZE);
      context.font = fontString(fragment.style);
      context.fillText(fragment.text, 0, 0);
      if (fragment.style.underline || fragment.style.overline || fragment.style.strike) {
        context.strokeStyle = context.fillStyle;
        context.lineWidth = 5;
        const top = result.multiline || vertical === 3 ? 0 : vertical === 2 ? -50 : -100;
        for (const position of [fragment.style.underline ? top + 110 : undefined, fragment.style.overline ? top : undefined, fragment.style.strike ? top + 55 : undefined]) {
          if (position === undefined) continue;
          context.beginPath(); context.moveTo(0, position * fragment.style.height);
          context.lineTo(fragment.width / fragment.style.width * MEASURE_SIZE, position * fragment.style.height); context.stroke();
        }
      }
      context.restore();
    }
  }
  return result;
}
