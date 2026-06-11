import { detectCadFormat, readInputBytes } from '../core/format';
import type { CadFormat, CadLoadInput, CadLoadOptions, CadLoadResult, CadLoader } from '../core/types';

export class CadLoaderRegistry {
  private readonly loaders: CadLoader[] = [];

  constructor(loaders: CadLoader[] = []) {
    for (const loader of loaders) this.register(loader);
  }

  register(loader: CadLoader): this {
    const index = this.loaders.findIndex((item) => item.id === loader.id);
    if (index >= 0) this.loaders.splice(index, 1, loader);
    else this.loaders.push(loader);
    return this;
  }

  unregister(loaderId: string): this {
    const index = this.loaders.findIndex((item) => item.id === loaderId);
    if (index >= 0) this.loaders.splice(index, 1);
    return this;
  }

  list(): CadLoader[] {
    return [...this.loaders];
  }

  async detect(input: CadLoadInput): Promise<{ loader: CadLoader; bytes: Uint8Array; format: CadFormat }> {
    const bytes = await readInputBytes(input);
    const format = detectCadFormat(input, bytes);
    const direct = this.loaders.find((loader) => loader.formats.includes(format) && loader.accepts(input, bytes));
    if (direct) return { loader: direct, bytes, format };
    const fallback = this.loaders.find((loader) => loader.accepts(input, bytes));
    if (fallback) return { loader: fallback, bytes, format };
    throw new Error(`No CAD loader registered for ${format === 'unknown' ? 'this file' : format.toUpperCase()}.`);
  }

  async load(input: CadLoadInput, options: CadLoadOptions = {}): Promise<CadLoadResult> {
    const { loader, bytes } = await this.detect(input);
    return loader.load({ ...input, buffer: bytes }, options);
  }
}
