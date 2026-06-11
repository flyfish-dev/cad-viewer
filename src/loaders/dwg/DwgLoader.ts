import { detectCadFormat, extensionOf, readInputBytes } from '../../core/format';
import type { CadLoadInput, CadLoadOptions, CadLoadResult, CadLoader } from '../../core/types';
import { DwgWorkerClient, supportsDwgWorker } from './DwgWorkerClient';

export class DwgLoader implements CadLoader {
  readonly id = 'dwg';
  readonly label = 'DWG / LibreDWG WebAssembly';
  readonly formats = ['dwg'] as const;
  private readonly defaults: CadLoadOptions;
  private readonly workerClient = new DwgWorkerClient();

  constructor(defaults: CadLoadOptions = {}) {
    this.defaults = { useWorker: true, ...defaults };
  }

  accepts(input: CadLoadInput, bytes?: Uint8Array): boolean {
    if (extensionOf(input) === 'dwg') return true;
    const format = detectCadFormat(input, bytes);
    return format === 'dwg';
  }

  async load(input: CadLoadInput, options: CadLoadOptions = {}): Promise<CadLoadResult> {
    const merged = { ...this.defaults, ...options };
    merged.onProgress?.({ phase: 'read', format: 'dwg', message: 'Reading DWG bytes…' });
    const bytes = await readInputBytes(input);
    const sourceName = input.fileName ?? input.file?.name;

    if (merged.useWorker === false) {
      throw new Error('DWG main-thread parsing is intentionally not bundled by the default viewer. Keep useWorker enabled, or register a custom DWG loader for non-browser runtimes.');
    }

    if (!supportsDwgWorker()) {
      throw new Error('DWG loading requires Web Worker support in this build. Provide a custom loader for this runtime.');
    }

    try {
      return await this.workerClient.load(bytes, input, { ...merged, fileName: sourceName });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw normalizeWorkerError(error);
    }
  }

  terminateWorker(): void {
    this.workerClient.terminate();
  }

  preload(options: CadLoadOptions = {}): Promise<void> {
    const merged = { ...this.defaults, ...options };
    if (merged.useWorker === false) {
      return Promise.reject(new Error('DWG preload requires worker mode in the default viewer.'));
    }
    return this.workerClient.preload(merged);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export { DwgWorkerClient, supportsDwgWorker } from './DwgWorkerClient';

function normalizeWorkerError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message} If the worker asset cannot be resolved by your bundler/CDN, pass workerUrl or workerFactory to CadViewer.`);
}
