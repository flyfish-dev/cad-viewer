import type { CadFormat, CadLoadInput } from './types';

export async function readInputBytes(input: CadLoadInput): Promise<Uint8Array> {
  if (input.buffer instanceof Uint8Array) return input.buffer;
  if (input.buffer instanceof ArrayBuffer) return new Uint8Array(input.buffer);
  if (input.file) return new Uint8Array(await input.file.arrayBuffer());
  throw new Error('CadLoadInput requires a File, ArrayBuffer, or Uint8Array.');
}

export function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer as ArrayBuffer;
  return bytes.slice().buffer as ArrayBuffer;
}

export function extensionOf(input: CadLoadInput): string {
  const name = input.fileName ?? input.file?.name ?? '';
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

export function detectCadFormat(input: CadLoadInput, bytes?: Uint8Array): CadFormat {
  const ext = extensionOf(input);
  if (ext === 'dwg') return 'dwg';
  if (ext === 'dxf') return 'dxf';
  if (ext === 'dwfx') return 'dwfx';
  if (ext === 'xps') return 'xps';
  if (ext === 'dwf') return 'dwf';

  if (bytes && bytes.byteLength >= 6) {
    const sig = ascii(bytes.slice(0, 6));
    if (/^AC10/.test(sig)) return 'dwg';
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'dwfx';
    const head = ascii(bytes.slice(0, Math.min(bytes.byteLength, 2048))).toUpperCase();
    if (head.includes('SECTION') && head.includes('ENTITIES')) return 'dxf';
    if (head.includes('DWF')) return 'dwf';
  }
  return 'unknown';
}

export function ascii(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b >= 32 && b <= 126 ? String.fromCharCode(b) : ' ').join('');
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}
