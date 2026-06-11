import type { CadDocument, CadEntity, CadLayer } from './types';

const BASE_ACI: Record<number, string> = {
  1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff',
  8: '#808080', 9: '#c0c0c0',
  10: '#ff0000', 11: '#ff7f7f', 12: '#a50000', 13: '#a55252', 14: '#7f0000', 15: '#7f3f3f', 16: '#4c0000', 17: '#4c2626', 18: '#260000', 19: '#261313',
  20: '#ff3f00', 21: '#ff9f7f', 22: '#a52900', 23: '#a56752', 24: '#7f1f00', 25: '#7f4f3f', 26: '#4c1300', 27: '#4c2f26', 28: '#260900', 29: '#261713',
  30: '#ff7f00', 31: '#ffbf7f', 32: '#a55200', 33: '#a57c52', 34: '#7f3f00', 35: '#7f5f3f', 36: '#4c2600', 37: '#4c3926', 38: '#261300', 39: '#261c13',
  40: '#ffbf00', 41: '#ffdf7f', 42: '#a57c00', 43: '#a59152', 44: '#7f5f00', 45: '#7f6f3f', 46: '#4c3900', 47: '#4c4226', 48: '#261c00', 49: '#262113',
  50: '#ffff00', 51: '#ffff7f', 52: '#a5a500', 53: '#a5a552', 54: '#7f7f00', 55: '#7f7f3f', 56: '#4c4c00', 57: '#4c4c26', 58: '#262600', 59: '#262613',
  60: '#bfff00', 61: '#dfff7f', 62: '#7ca500', 63: '#91a552', 64: '#5f7f00', 65: '#6f7f3f', 66: '#394c00', 67: '#424c26', 68: '#1c2600', 69: '#212613',
  70: '#7fff00', 71: '#bfff7f', 72: '#52a500', 73: '#7ca552', 74: '#3f7f00', 75: '#5f7f3f', 76: '#264c00', 77: '#394c26', 78: '#132600', 79: '#1c2613',
  80: '#3fff00', 81: '#9fff7f', 82: '#29a500', 83: '#67a552', 84: '#1f7f00', 85: '#4f7f3f', 86: '#134c00', 87: '#2f4c26', 88: '#092600', 89: '#172613',
  90: '#00ff00', 91: '#7fff7f', 92: '#00a500', 93: '#52a552', 94: '#007f00', 95: '#3f7f3f', 96: '#004c00', 97: '#264c26', 98: '#002600', 99: '#132613',
  100: '#00ff3f', 101: '#7fff9f', 102: '#00a529', 103: '#52a567', 104: '#007f1f', 105: '#3f7f4f', 106: '#004c13', 107: '#264c2f', 108: '#002609', 109: '#132617',
  110: '#00ff7f', 111: '#7fffbf', 112: '#00a552', 113: '#52a57c', 114: '#007f3f', 115: '#3f7f5f', 116: '#004c26', 117: '#264c39', 118: '#002613', 119: '#13261c',
  120: '#00ffbf', 121: '#7fffdf', 122: '#00a57c', 123: '#52a591', 124: '#007f5f', 125: '#3f7f6f', 126: '#004c39', 127: '#264c42', 128: '#00261c', 129: '#132621',
  130: '#00ffff', 131: '#7fffff', 132: '#00a5a5', 133: '#52a5a5', 134: '#007f7f', 135: '#3f7f7f', 136: '#004c4c', 137: '#264c4c', 138: '#002626', 139: '#132626',
  140: '#00bfff', 141: '#7fdfff', 142: '#007ca5', 143: '#5291a5', 144: '#005f7f', 145: '#3f6f7f', 146: '#00394c', 147: '#26424c', 148: '#001c26', 149: '#132126',
  150: '#007fff', 151: '#7fbfff', 152: '#0052a5', 153: '#527ca5', 154: '#003f7f', 155: '#3f5f7f', 156: '#00264c', 157: '#26394c', 158: '#001326', 159: '#131c26',
  160: '#003fff', 161: '#7f9fff', 162: '#0029a5', 163: '#5267a5', 164: '#001f7f', 165: '#3f4f7f', 166: '#00134c', 167: '#262f4c', 168: '#000926', 169: '#131726',
  170: '#0000ff', 171: '#7f7fff', 172: '#0000a5', 173: '#5252a5', 174: '#00007f', 175: '#3f3f7f', 176: '#00004c', 177: '#26264c', 178: '#000026', 179: '#131326',
  180: '#3f00ff', 181: '#9f7fff', 182: '#2900a5', 183: '#6752a5', 184: '#1f007f', 185: '#4f3f7f', 186: '#13004c', 187: '#2f264c', 188: '#090026', 189: '#171326',
  190: '#7f00ff', 191: '#bf7fff', 192: '#5200a5', 193: '#7c52a5', 194: '#3f007f', 195: '#5f3f7f', 196: '#26004c', 197: '#39264c', 198: '#130026', 199: '#1c1326',
  200: '#bf00ff', 201: '#df7fff', 202: '#7c00a5', 203: '#9152a5', 204: '#5f007f', 205: '#6f3f7f', 206: '#39004c', 207: '#42264c', 208: '#1c0026', 209: '#211326',
  210: '#ff00ff', 211: '#ff7fff', 212: '#a500a5', 213: '#a552a5', 214: '#7f007f', 215: '#7f3f7f', 216: '#4c004c', 217: '#4c264c', 218: '#260026', 219: '#261326',
  220: '#ff00bf', 221: '#ff7fdf', 222: '#a5007c', 223: '#a55291', 224: '#7f005f', 225: '#7f3f6f', 226: '#4c0039', 227: '#4c2642', 228: '#26001c', 229: '#261321',
  230: '#ff007f', 231: '#ff7fbf', 232: '#a50052', 233: '#a5527c', 234: '#7f003f', 235: '#7f3f5f', 236: '#4c0026', 237: '#4c2639', 238: '#260013', 239: '#26131c',
  240: '#ff003f', 241: '#ff7f9f', 242: '#a50029', 243: '#a55267', 244: '#7f001f', 245: '#7f3f4f', 246: '#4c0013', 247: '#4c262f', 248: '#260009', 249: '#261317',
  250: '#333333', 251: '#505050', 252: '#696969', 253: '#828282', 254: '#bebebe', 255: '#ffffff'
};


export type CadColorContrastMode = 'preserve' | 'adaptive';

export interface ColorResolveOptions {
  foreground?: string;
  background?: string;
  trueColorByteOrder?: 'rgb' | 'bgr';
  contrastMode?: CadColorContrastMode;
  minColorContrast?: number;
}

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function colorFromAci(index: number | undefined, fallback = '#ffffff', foreground = fallback): string {
  if (typeof index !== 'number' || Number.isNaN(index)) return fallback;
  const normalized = Math.abs(Math.trunc(index));
  if (normalized === 0 || normalized === 256 || normalized === 257) return fallback;
  // ACI 7 is intentionally foreground-dependent in CAD viewers: it should be
  // black on a light canvas and white on a dark canvas.
  if (normalized === 7) return foreground;
  return BASE_ACI[normalized] ?? fallback;
}

export function colorFromTrueColor(value: number, byteOrder: 'rgb' | 'bgr' = 'rgb'): string {
  const int = Math.max(0, Math.trunc(value)) & 0xffffff;
  const a = (int >> 16) & 0xff;
  const b = (int >> 8) & 0xff;
  const c = int & 0xff;
  const red = byteOrder === 'rgb' ? a : c;
  const green = b;
  const blue = byteOrder === 'rgb' ? c : a;
  return `rgb(${red}, ${green}, ${blue})`;
}

export function parseCssColor(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const v = value.trim();
    if (!v) return undefined;
    if (/^(#|rgb\(|rgba\(|hsl\(|hsla\()/i.test(v)) return normalizeXpsColor(v) ?? v;
    const named: Record<string, string> = {
      red: '#ff0000',
      yellow: '#ffff00',
      green: '#00ff00',
      cyan: '#00ffff',
      blue: '#0000ff',
      magenta: '#ff00ff',
      white: '#ffffff',
      black: '#000000',
      grey: '#808080',
      gray: '#808080'
    };
    return named[v.toLowerCase()];
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const r = Number(obj.r ?? obj.red);
    const g = Number(obj.g ?? obj.green);
    const b = Number(obj.b ?? obj.blue);
    const a = Number(obj.a ?? obj.alpha ?? 1);
    if ([r, g, b].every(Number.isFinite)) {
      return Number.isFinite(a) && a >= 0 && a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`;
    }
  }
  return undefined;
}

export function normalizeXpsColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{8}$/i.test(trimmed)) {
    const a = parseInt(trimmed.slice(1, 3), 16) / 255;
    const r = parseInt(trimmed.slice(3, 5), 16);
    const g = parseInt(trimmed.slice(5, 7), 16);
    const b = parseInt(trimmed.slice(7, 9), 16);
    return a >= 0.999 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${roundAlpha(a)})`;
  }
  if (/^#[0-9a-f]{6}$/i.test(trimmed) || /^#[0-9a-f]{3}$/i.test(trimmed)) return trimmed;
  if (/^sc#/i.test(trimmed)) {
    const parts = trimmed.slice(3).split(',').map((x) => Number(x.trim()));
    const [a, r, g, b] = parts.length === 4 ? parts : [1, ...parts];
    if ([a, r, g, b].every(Number.isFinite)) return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${roundAlpha(a)})`;
  }
  return undefined;
}

export function resolveCadColor(entity: CadEntity, document?: CadDocument, options: ColorResolveOptions = {}): string {
  const foreground = options.foreground ?? '#ffffff';
  const fallback = foreground;
  let color: string | undefined;

  const explicit = parseCssColor(entity.trueColor) ?? parseCssColor(entity.color) ?? parseCssColor(entity.colorName);
  if (explicit) color = explicit;

  if (!color) {
    const trueColorCandidate = numberFromKeys(entity, ['trueColor', 'true_color', 'truecolor', 'colorRGB', 'colorRgb', 'rgbColor', 'rgb']);
    if (typeof trueColorCandidate === 'number' && trueColorCandidate >= 0 && trueColorCandidate <= 0xffffff) {
      color = colorFromTrueColor(trueColorCandidate, options.trueColorByteOrder ?? 'rgb');
    }
  }

  if (!color) {
    const aci = firstNumber(entity.colorIndex, entity.colorNumber, (entity as Record<string, unknown>).aci);
    if (typeof aci === 'number' && Math.abs(aci) <= 257 && aci !== 256 && aci !== 0 && aci !== 257) color = colorFromAci(aci, fallback, foreground);
  }

  if (!color && typeof entity.color === 'number') {
    const c = Number(entity.color);
    // Most DWG/DXF JavaScript parsers expose `color` as ACI for values 1..257.
    // Treating those values as RGB is the common cause of nearly black drawings.
    if (Math.abs(c) <= 257) {
      if (c !== 0 && c !== 256 && c !== 257) color = colorFromAci(c, fallback, foreground);
    } else {
      color = colorFromTrueColor(c, options.trueColorByteOrder ?? 'rgb');
    }
  }

  if (!color) {
    const layer = lookupLayer(document, entity.layer);
    color = resolveLayerColor(layer, options);
  }

  return adaptColorForCanvas(color ?? fallback, options);
}

export function resolveFillColor(entity: CadEntity, document?: CadDocument, options: ColorResolveOptions = {}): string | undefined {
  let color: string | undefined;
  const explicit = parseCssColor(entity.fillColor);
  if (explicit) color = explicit;
  if (!color && typeof entity.fillColor === 'number') {
    const n = entity.fillColor;
    color = Math.abs(n) <= 257 ? colorFromAci(n, options.foreground ?? '#ffffff', options.foreground ?? '#ffffff') : colorFromTrueColor(n, options.trueColorByteOrder ?? 'rgb');
  }
  if (!color && typeof entity.fillColorIndex === 'number') color = colorFromAci(entity.fillColorIndex, options.foreground ?? '#ffffff', options.foreground ?? '#ffffff');
  return color ? adaptColorForCanvas(color, options) : undefined;
}

export function adaptColorForCanvas(color: string, options: ColorResolveOptions = {}): string {
  if (options.contrastMode !== 'adaptive') return color;
  const background = options.background ?? '#0b1020';
  const foreground = options.foreground ?? '#ffffff';
  return ensureContrast(color, background, foreground, options.minColorContrast ?? 2.4);
}

export function ensureContrast(color: string, background: string, foreground: string, minRatio = 2.4): string {
  const fg = parseRgba(foreground) ?? { r: 255, g: 255, b: 255, a: 1 };
  const bg = parseRgba(background) ?? { r: 11, g: 16, b: 32, a: 1 };
  const raw = parseRgba(color);
  if (!raw) return color;

  const effective = alphaComposite(raw, bg);
  if (contrastRatio(effective, bg) >= minRatio) return color;

  const bgLum = relativeLuminance(bg);
  const target = bgLum < 0.5 ? { r: 255, g: 255, b: 255, a: raw.a } : { r: 0, g: 0, b: 0, a: raw.a };
  for (const amount of [0.25, 0.4, 0.55, 0.7, 0.85, 1]) {
    const mixed = mix(raw, target, amount);
    if (contrastRatio(alphaComposite(mixed, bg), bg) >= minRatio) return toCssColor(mixed);
  }

  if (contrastRatio(fg, bg) >= minRatio) return toCssColor(fg);
  return bgLum < 0.5 ? '#ffffff' : '#000000';
}

export function layerVisible(layer: CadLayer | undefined): boolean {
  if (!layer) return true;
  return layer.isVisible !== false && layer.isFrozen !== true;
}

function resolveLayerColor(layer: CadLayer | undefined, options: ColorResolveOptions): string | undefined {
  if (!layer) return undefined;
  const foreground = options.foreground ?? '#ffffff';

  const trueColorText = parseCssColor(layer.trueColor);
  if (trueColorText) return trueColorText;
  if (typeof layer.trueColor === 'number' && layer.trueColor >= 0 && layer.trueColor <= 0xffffff) return colorFromTrueColor(layer.trueColor, options.trueColorByteOrder ?? 'rgb');

  const explicitColorText = parseCssColor(layer.color);
  if (explicitColorText) return explicitColorText;

  // Prefer a valid ACI index over a numeric `layer.color` when both are
  // present. LibreDWG's JS converter uses `color: 0xffffff` as a placeholder
  // for many indexed-color layers; using that value first turns drawings
  // monochrome white. The ACI index is the authoritative layer color in that
  // case.
  if (isRenderableAci(layer.colorIndex)) return colorFromAci(layer.colorIndex, foreground, foreground);

  if (typeof layer.color === 'number') {
    const c = Number(layer.color);
    return Math.abs(c) <= 257 ? colorFromAci(c, foreground, foreground) : colorFromTrueColor(c, options.trueColorByteOrder ?? 'rgb');
  }
  if (typeof layer.colorIndex === 'number') return colorFromAci(layer.colorIndex, foreground, foreground);
  return undefined;
}


export function isByBlockColor(entity: CadEntity): boolean {
  const aci = firstNumber(entity.colorIndex, entity.colorNumber, (entity as Record<string, unknown>).aci);
  if (aci === 0) return true;
  return entity.trueColor === undefined && entity.color === 0;
}

export function applyByBlockColorInheritance(entity: CadEntity, parent: CadEntity, document?: CadDocument, options: ColorResolveOptions = {}): CadEntity {
  if (!isByBlockColor(entity)) return entity;
  const inheritedColor = resolveCadColor(parent, document, options);
  const clone: CadEntity = { ...entity, color: inheritedColor, trueColor: undefined, colorIndex: undefined, colorNumber: undefined };
  return clone;
}

function isRenderableAci(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(Math.trunc(value)) >= 1 && Math.abs(Math.trunc(value)) <= 255;
}

function lookupLayer(document: CadDocument | undefined, name: string | undefined): CadLayer | undefined {
  if (!document || !name) return undefined;
  return document.layers[name] ?? document.layers[name.toLowerCase()] ?? Object.values(document.layers).find((x) => x.name.toLowerCase() === name.toLowerCase());
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function numberFromKeys(entity: CadEntity, keys: string[]): number | undefined {
  const record = entity as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function parseRgba(value: string): RgbaColor | undefined {
  const input = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(input)) {
    return {
      r: parseInt(input[1] + input[1], 16),
      g: parseInt(input[2] + input[2], 16),
      b: parseInt(input[3] + input[3], 16),
      a: 1
    };
  }
  if (/^#[0-9a-f]{6}$/i.test(input)) {
    return {
      r: parseInt(input.slice(1, 3), 16),
      g: parseInt(input.slice(3, 5), 16),
      b: parseInt(input.slice(5, 7), 16),
      a: 1
    };
  }
  const rgba = input.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(/[,\s/]+/).filter(Boolean).map((part) => Number(part.replace('%', '')));
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      const hasPercent = /%/.test(rgba[1]);
      return {
        r: clampByte(hasPercent ? parts[0] * 2.55 : parts[0]),
        g: clampByte(hasPercent ? parts[1] * 2.55 : parts[1]),
        b: clampByte(hasPercent ? parts[2] * 2.55 : parts[2]),
        a: Number.isFinite(parts[3]) ? Math.max(0, Math.min(1, parts[3])) : 1
      };
    }
  }
  return undefined;
}

function alphaComposite(color: RgbaColor, background: RgbaColor): RgbaColor {
  const a = color.a + background.a * (1 - color.a);
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (color.r * color.a + background.r * background.a * (1 - color.a)) / a,
    g: (color.g * color.a + background.g * background.a * (1 - color.a)) / a,
    b: (color.b * color.a + background.b * background.a * (1 - color.a)) / a,
    a
  };
}

function mix(a: RgbaColor, b: RgbaColor, amount: number): RgbaColor {
  const t = Math.max(0, Math.min(1, amount));
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a
  };
}

function relativeLuminance(color: RgbaColor): number {
  const channels = [color.r, color.g, color.b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a: RgbaColor, b: RgbaColor): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function toCssColor(color: RgbaColor): string {
  const r = clampByte(color.r);
  const g = clampByte(color.g);
  const b = clampByte(color.b);
  return color.a < 0.999 ? `rgba(${r}, ${g}, ${b}, ${roundAlpha(color.a)})` : `rgb(${r}, ${g}, ${b})`;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function roundAlpha(value: number): number {
  return Math.round(value * 1000) / 1000;
}
