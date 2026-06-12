import { createLogger, defineConfig, type Plugin } from 'vite';
import { resolve as pathResolve } from 'node:path';

const logger = createFilteredLogger();

export default defineConfig({
  publicDir: false,
  customLogger: logger,
  plugins: [libredwgRuntimePatchPlugin()],
  resolve: {
    alias: {
      // See vite.config.ts. The lean wrapper avoids bundling the upstream
      // inline-wasm distribution into our worker/demo output.
      '@mlightcad/libredwg-web': pathResolve(__dirname, 'node_modules/@mlightcad/libredwg-web/lib/index.js'),
      [pathResolve(__dirname, 'node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.js')]: pathResolve(__dirname, 'src/loaders/dwg/libredwgWasmModuleProxy.ts')
    }
  },
  worker: { format: 'es', plugins: () => [libredwgRuntimePatchPlugin()] },
  build: {
    lib: {
      entry: pathResolve(__dirname, 'src/index.ts'),
      name: 'LightweightCadViewer',
      formats: ['es', 'umd'],
      fileName: (format) => format === 'es' ? 'cad-viewer.es.js' : 'cad-viewer.umd.cjs',
      cssFileName: 'style'
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: ['dxf-parser', 'dwf-viewer'],
      output: {
        globals: {
          'dxf-parser': 'DxfParser',
          'dwf-viewer': 'DwfViewerPackage'
        }
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
    name: 'lightweight-cad-viewer:libredwg-runtime-patch',
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
      // Keep Vite from turning the upstream wasm URL into an extra emitted asset.
      // We supply wasmBinary and locateFile explicitly in DwgParser, so this
      // fallback branch is not needed by the viewer runtime.
      next = next.replace(/new URL\((['"])libredwg-web\.wasm\1\s*,\s*import\.meta\.url\)/g, 'new URL(/* @vite-ignore */ $1libredwg-web.wasm$1, import.meta.url)');
      // Extra guard for the upstream package root, which embeds a data: wasm URL.
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
