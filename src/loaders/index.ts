import { CadLoaderRegistry } from './CadLoaderRegistry.js';
import { DwgLoader } from './dwg/DwgLoader.js';
import { DxfLoader } from './dxf/DxfLoader.js';
import { DwfLoader } from './dwf/DwfLoader.js';
import type { CadLoadOptions } from '../core/types.js';

export function createDefaultLoaderRegistry(options: CadLoadOptions = {}): CadLoaderRegistry {
  return new CadLoaderRegistry([
    new DwgLoader(options),
    new DxfLoader(options),
    new DwfLoader(options)
  ]);
}

export { CadLoaderRegistry } from './CadLoaderRegistry.js';
export { DwgLoader, DwgWorkerClient, supportsDwgWorker } from './dwg/DwgLoader.js';
export { DxfLoader } from './dxf/DxfLoader.js';
export { DwfLoader } from './dwf/DwfLoader.js';
