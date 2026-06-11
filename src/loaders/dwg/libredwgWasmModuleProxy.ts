/**
 * Runtime proxy for @mlightcad/libredwg-web/wasm/libredwg-web.js.
 *
 * The npm package root points Vite at a distribution file that embeds a huge
 * inline wasm data URL. The lean package wrapper imports the wasm glue file
 * directly, but Vite still tries to rewrite its `new URL('libredwg-web.wasm',
 * import.meta.url)` fallback and emits a duplicated .wasm asset.
 *
 * This proxy keeps the application bundle small: the worker loads the official
 * Emscripten glue from the public wasm directory at runtime, and DwgParser
 * provides the real wasm bytes through `wasmBinary`.
 */
export default async function createModule(moduleArg: Record<string, unknown> = {}): Promise<any> {
  const runtimeUrl = resolveRuntimeJsUrl(moduleArg);
  const module = await import(/* @vite-ignore */ runtimeUrl);
  const factory = (module as { default?: unknown; createModule?: unknown }).default ?? (module as { createModule?: unknown }).createModule ?? module;
  if (typeof factory !== 'function') {
    throw new Error(`LibreDWG runtime module at ${runtimeUrl} did not export a createModule function.`);
  }
  return (factory as (arg?: Record<string, unknown>) => Promise<any>)(moduleArg);
}

function resolveRuntimeJsUrl(moduleArg: Record<string, unknown>): string {
  const locateFile = moduleArg.locateFile;
  if (typeof locateFile === 'function') {
    try {
      const located = (locateFile as (filename: string, scriptDirectory?: string) => string)('libredwg-web.js', '');
      if (typeof located === 'string' && located.length > 0) return located;
    } catch {
      // Fall back to document-relative /wasm below.
    }
  }
  if (typeof document !== 'undefined' && document.baseURI) return new URL('wasm/libredwg-web.js', document.baseURI).href;
  if (typeof location !== 'undefined' && location.href) return new URL('/wasm/libredwg-web.js', location.origin).href;
  return '/wasm/libredwg-web.js';
}
