import { CadLoaderRegistry } from './CadLoaderRegistry';
import { DwgLoader } from './dwg/DwgLoader';
import { DxfLoader } from './dxf/DxfLoader';
import { DwfLoader } from './dwf/DwfLoader';
import type { CadLoadOptions } from '../core/types';

export function createDefaultLoaderRegistry(options: CadLoadOptions = {}): CadLoaderRegistry {
  return new CadLoaderRegistry([
    new DwgLoader(options),
    new DxfLoader(options),
    new DwfLoader(options)
  ]);
}

export { CadLoaderRegistry } from './CadLoaderRegistry';
export { DwgLoader, DwgWorkerClient, supportsDwgWorker } from './dwg/DwgLoader';
export { DxfLoader } from './dxf/DxfLoader';
export { DwfLoader } from './dwf/DwfLoader';
