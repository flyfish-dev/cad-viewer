import { createLogger, defineConfig, type Plugin } from 'vite';
import { resolve as pathResolve } from 'node:path';

const logger = createFilteredLogger();

export default defineConfig({
  publicDir: false,
  customLogger: logger,
  plugins: [libredwgRuntimePatchPlugin()],
  resolve: {
    alias: {
      '@mlightcad/libredwg-web': pathResolve(__dirname, 'node_modules/@mlightcad/libredwg-web/lib/index.js'),
      [pathResolve(__dirname, 'node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.js')]: pathResolve(__dirname, 'src/loaders/dwg/libredwgWasmModuleProxy.ts')
    }
  },
  build: {
    outDir: 'dist/wasm',
    emptyOutDir: false,
    sourcemap: true,
    target: 'es2020',
    rollupOptions: {
      input: pathResolve(__dirname, 'src/loaders/dwg/DwgWorker.ts'),
      output: {
        format: 'es',
        inlineDynamicImports: true,
        entryFileNames: 'dwg-worker.js',
        assetFileNames: '[name][extname]'
      },
      onwarn(warning, warn) {
        if (shouldSuppressBuildWarning(warning.message, warning)) return;
        warn(warning);
      }
    }
  }
});

function libredwgRuntimePatchPlugin(): Plugin {
  return {
    name: 'lightweight-cad-viewer:libredwg-worker-runtime-patch',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '../wasm/libredwg-web.js' && importer?.includes('@mlightcad/libredwg-web/lib/libredwg.js')) {
        return pathResolve(__dirname, 'src/loaders/dwg/libredwgWasmModuleProxy.ts');
      }
      return null;
    },
    transform(code, id) {
      if (!id.includes('@mlightcad/libredwg-web')) return null;
      let next = code;
      next = next.replace(/new URL\((['"])libredwg-web\.wasm\1\s*,\s*import\.meta\.url\)/g, 'new URL(/* @vite-ignore */ $1libredwg-web.wasm$1, import.meta.url)');
      next = next.replace(/new URL\((['"])data:application\/wasm;base64,/g, 'new URL(/* @vite-ignore */ $1data:application/wasm;base64,');
      return next === code ? null : { code: next, map: null };
    }
  };
}

function createFilteredLogger() {
  const logger = createLogger();
  const warn = logger.warn;
  logger.warn = (message, options) => {
    if (shouldSuppressBuildWarning(String(message))) return;
    warn(message, options);
  };
  return logger;
}

function shouldSuppressBuildWarning(message: string | undefined, warning?: { plugin?: string; id?: string }): boolean {
  const text = String(message ?? '');
  const id = String(warning?.id ?? '');
  const plugin = String(warning?.plugin ?? '');
  return Boolean(
    text.includes('Module "module" has been externalized') ||
    text.includes('data:application/wasm;base64') ||
    (plugin === 'vite:asset-import-meta-url' && id.includes('@mlightcad/libredwg-web')) ||
    (text.includes("doesn't exist at build time") && text.includes('import.meta.url') && (id.includes('@mlightcad/libredwg-web') || text.length > 1000))
  );
}
