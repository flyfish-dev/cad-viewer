/// <reference lib="webworker" />

import { createLibreDwg, parseDwgBytes } from './DwgParser';
import type { CadLoadOptions, CadLoadProgress } from '../../core/types';

type DwgWorkerLoadRequest = {
  type: 'load';
  requestId: number;
  bytes: ArrayBuffer;
  fileName?: string;
  options?: CadLoadOptions;
};

type DwgWorkerWarmupRequest = {
  type: 'warmup';
  requestId: number;
  options?: CadLoadOptions;
};

type DwgWorkerRequest = DwgWorkerLoadRequest | DwgWorkerWarmupRequest;

const scope = self as DedicatedWorkerGlobalScope;

scope.postMessage({ type: 'ready' });

scope.onmessage = async (event: MessageEvent<DwgWorkerRequest>) => {
  const request = event.data;
  if (!request) return;
  const started = performance.now();
  const emit = (progress: CadLoadProgress) => {
    scope.postMessage({ type: 'progress', requestId: request.requestId, progress });
  };

  try {
    if (request.type === 'warmup') {
      emit({ phase: 'wasm-init', format: 'dwg', message: 'Warming LibreDWG WebAssembly instance…' });
      await createLibreDwg(request.options?.wasmPath ?? '/wasm/');
      scope.postMessage({ type: 'warmup-result', requestId: request.requestId, elapsedMs: performance.now() - started });
      return;
    }

    if (request.type !== 'load') return;
    emit({ phase: 'worker-ready', format: 'dwg', message: 'DWG worker received file bytes.', total: request.bytes.byteLength });
    const result = await parseDwgBytes(new Uint8Array(request.bytes), {
      ...request.options,
      sourceName: request.fileName,
      keepRaw: Boolean(request.options?.keepRaw),
      onProgress: emit
    });
    result.document.metadata.loaderMode = 'worker';
    result.elapsedMs = performance.now() - started;
    scope.postMessage({ type: 'result', requestId: request.requestId, result });
  } catch (error) {
    const normalized = normalizeWorkerError(error);
    scope.postMessage({ type: 'error', requestId: request.requestId, error: normalized });
  }
};

function normalizeWorkerError(error: unknown): { name?: string; message: string; stack?: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { message: String(error) };
}
