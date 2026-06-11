declare module '@mlightcad/libredwg-web' {
  export const Dwg_File_Type: Record<string, number>;
  export const LibreDwg: {
    create(wasmPath?: string): Promise<any>;
  };
}

declare module 'dxf-parser' {
  export default class DxfParser {
    parseSync(text: string): unknown;
  }
  export class DxfParser {
    parseSync(text: string): unknown;
  }
}

declare module 'fflate' {
  export function unzipSync(data: Uint8Array): Record<string, Uint8Array>;
}
