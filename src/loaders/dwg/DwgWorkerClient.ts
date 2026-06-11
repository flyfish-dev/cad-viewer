import { exactArrayBuffer } from '../../core/format';
import type { CadLoadInput, CadLoadOptions, CadLoadProgress, CadLoadResult } from '../../core/types';

export interface DwgWorkerLoadOptions extends CadLoadOptions {
  fileName?: string;
}

type DwgWorkerProgressMessage = {
  type: 'progress';
  requestId: number;
  progress: CadLoadProgress;
};

type DwgWorkerResultMessage = {
  type: 'result';
  requestId: number;
  result: CadLoadResult;
};

type DwgWorkerWarmupResultMessage = {
  type: 'warmup-result';
  requestId: number;
  elapsedMs: number;
};

type DwgWorkerErrorMessage = {
  type: 'error';
  requestId: number;
  error: {
    name?: string;
    message: string;
    stack?: string;
  };
};

type DwgWorkerReadyMessage = {
  type: 'ready';
};

type DwgWorkerMessage = DwgWorkerProgressMessage | DwgWorkerResultMessage | DwgWorkerWarmupResultMessage | DwgWorkerErrorMessage | DwgWorkerReadyMessage;

type PendingRequest = {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: CadLoadProgress) => void;
  timer?: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
  signal?: AbortSignal;
};

export class DwgWorkerClient {
  private worker?: Worker;
  private sequence = 0;
  private readonly pending = new Map<number, PendingRequest>();

  load(bytes: Uint8Array, input: CadLoadInput, options: DwgWorkerLoadOptions = {}): Promise<CadLoadResult> {
    if (!supportsDwgWorker()) throw new Error('Web Worker is not available in this runtime.');
    const worker = this.ensureWorker(options);
    const requestId = ++this.sequence;
    const timeout = Math.max(0, Number(options.workerTimeoutMs ?? 0));
    const fileName = options.fileName ?? input.fileName ?? input.file?.name;
    const transferBuffer = prepareTransferBuffer(bytes, input, options);

    options.onProgress?.({ phase: 'worker-start', format: 'dwg', message: 'Dispatching DWG parse to worker…', total: bytes.byteLength });

    return new Promise<CadLoadResult>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(createAbortError());
        return;
      }
      const pending: PendingRequest = { resolve, reject, onProgress: options.onProgress, signal: options.signal };
      if (timeout > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(requestId);
          this.resetWorker();
          reject(new Error(`DWG worker timed out after ${timeout} ms.`));
        }, timeout);
      }
      if (options.signal) {
        pending.abortHandler = () => {
          this.pending.delete(requestId);
          this.resetWorker();
          reject(createAbortError());
        };
        options.signal.addEventListener('abort', pending.abortHandler, { once: true });
      }
      this.pending.set(requestId, pending);
      try {
        worker.postMessage({
          type: 'load',
          requestId,
          bytes: transferBuffer,
          fileName,
          options: serializeOptions(options)
        }, [transferBuffer]);
      } catch (error) {
        this.pending.delete(requestId);
        cleanupPending(pending);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  preload(options: DwgWorkerLoadOptions = {}): Promise<void> {
    if (!supportsDwgWorker()) return Promise.reject(new Error('Web Worker is not available in this runtime.'));
    const worker = this.ensureWorker(options);
    const requestId = ++this.sequence;
    const timeout = Math.max(0, Number(options.workerTimeoutMs ?? 0));
    options.onProgress?.({ phase: 'worker-start', format: 'dwg', message: 'Starting DWG worker warmup…' });

    return new Promise<void>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(createAbortError());
        return;
      }
      const pending: PendingRequest = {
        resolve: () => resolve(),
        reject,
        onProgress: options.onProgress,
        signal: options.signal
      };
      if (timeout > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(requestId);
          this.resetWorker();
          reject(new Error(`DWG worker warmup timed out after ${timeout} ms.`));
        }, timeout);
      }
      if (options.signal) {
        pending.abortHandler = () => {
          this.pending.delete(requestId);
          this.resetWorker();
          reject(createAbortError());
        };
        options.signal.addEventListener('abort', pending.abortHandler, { once: true });
      }
      this.pending.set(requestId, pending);
      try {
        worker.postMessage({ type: 'warmup', requestId, options: serializeOptions(options) });
      } catch (error) {
        this.pending.delete(requestId);
        cleanupPending(pending);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  terminate(): void {
    this.resetWorker();
  }

  private ensureWorker(options: DwgWorkerLoadOptions): Worker {
    if (!this.worker) {
      this.worker = createWorker(options);
      this.worker.onmessage = (event: MessageEvent<DwgWorkerMessage>) => this.handleMessage(event.data);
      this.worker.onerror = (event) => {
        const message = event.message || 'DWG worker failed.';
        this.rejectAll(new Error(message));
        this.resetWorker(false);
      };
      this.worker.onmessageerror = () => {
        this.rejectAll(new Error('DWG worker returned a message that could not be cloned.'));
        this.resetWorker(false);
      };
    }
    return this.worker;
  }

  private handleMessage(message: DwgWorkerMessage): void {
    if (message.type === 'ready') return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;

    if (message.type === 'progress') {
      pending.onProgress?.(message.progress);
      return;
    }

    this.pending.delete(message.requestId);
    cleanupPending(pending);

    if (message.type === 'result') {
      pending.resolve(message.result);
      return;
    }

    if (message.type === 'warmup-result') {
      pending.onProgress?.({ phase: 'worker-ready', format: 'dwg', message: 'DWG worker warmup complete.', percent: 100, elapsedMs: message.elapsedMs });
      pending.resolve(undefined);
      return;
    }

    const error = new Error(message.error.message);
    error.name = message.error.name || 'DwgWorkerError';
    if (message.error.stack) error.stack = message.error.stack;
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      cleanupPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private resetWorker(reject = true): void {
    if (reject) this.rejectAll(new Error('DWG worker was terminated.'));
    this.worker?.terminate();
    this.worker = undefined;
  }
}

export function supportsDwgWorker(): boolean {
  return typeof Worker !== 'undefined' && typeof URL !== 'undefined';
}

function createWorker(options: DwgWorkerLoadOptions): Worker {
  if (options.workerFactory) return options.workerFactory();
  if (options.workerUrl) return new Worker(options.workerUrl, { type: 'module', name: 'lightweight-cad-dwg-loader' });
  return new Worker(new URL('./DwgWorker.ts', import.meta.url), { type: 'module', name: 'lightweight-cad-dwg-loader' });
}

function serializeOptions(options: DwgWorkerLoadOptions): Record<string, unknown> {
  return {
    // Resolve the asset directory on the UI thread. Relative paths such as
    // './wasm' must be relative to the document URL, not to the generated
    // worker chunk URL. Otherwise the worker may request /assets/wasm/... and
    // receive the app's HTML fallback instead of libredwg-web.wasm.
    wasmPath: resolveWasmPathForWorker(options.wasmPath),
    includePaperSpace: options.includePaperSpace,
    maxInsertDepth: options.maxInsertDepth,
    keepRaw: Boolean(options.keepRaw)
  };
}

function prepareTransferBuffer(bytes: Uint8Array, input: CadLoadInput, options: DwgWorkerLoadOptions): ArrayBuffer {
  const canTransferWithoutSurprise = Boolean(input.file) || options.transferInputBuffer === true;
  if (canTransferWithoutSurprise) return exactArrayBuffer(bytes);
  return bytes.slice().buffer as ArrayBuffer;
}

function cleanupPending(pending: PendingRequest): void {
  if (pending.timer) clearTimeout(pending.timer);
  if (pending.signal && pending.abortHandler) pending.signal.removeEventListener('abort', pending.abortHandler);
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('DWG loading was aborted.', 'AbortError');
  const error = new Error('DWG loading was aborted.');
  error.name = 'AbortError';
  return error;
}

function resolveWasmPathForWorker(wasmPath: string | undefined): string {
  const candidate = (wasmPath?.trim() || '/wasm').replace(/\/+$/, '');
  if (candidate === '') return getPageOrigin();
  if (isAbsoluteUrl(candidate)) return candidate;
  if (candidate.startsWith('/')) return `${getPageOrigin()}${candidate}`;
  return new URL(candidate, getPageBaseUrl()).href.replace(/\/+$/, '');
}

function getPageBaseUrl(): string {
  if (typeof document !== 'undefined' && document.baseURI) return document.baseURI;
  if (typeof location !== 'undefined' && location.href) return location.href;
  return 'http://localhost/';
}

function getPageOrigin(): string {
  if (typeof location !== 'undefined' && location.origin) return location.origin;
  return new URL(getPageBaseUrl()).origin;
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}
