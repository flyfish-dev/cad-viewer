import { createLogger, defineConfig, type Plugin } from 'vite';
import { resolve as pathResolve } from 'node:path';

const logger = createFilteredLogger();

export default defineConfig({
  base: './',
  publicDir: 'public',
  customLogger: logger,
  plugins: [libredwgRuntimePatchPlugin(), devCompatibilityPlugin()],
  resolve: {
    alias: {
      // The published package root points to dist/libredwg-web.js, which embeds
      // a huge data:application/wasm URL. Vite then prints megabytes of base64
      // during build. Use the package's lean ESM wrapper instead; the actual
      // .wasm file is loaded from public/wasm through wasmPath.
      '@mlightcad/libredwg-web': pathResolve(__dirname, 'node_modules/@mlightcad/libredwg-web/lib/index.js'),
      [pathResolve(__dirname, 'node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.js')]: pathResolve(__dirname, 'src/loaders/dwg/libredwgWasmModuleProxy.ts')
    }
  },
  worker: { format: 'es', plugins: () => [libredwgRuntimePatchPlugin()] },
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      onwarn(warning, warn) {
        if (shouldSuppressBuildWarning(warning.message, warning)) return;
        warn(warning);
      }
    }
  },
  server: {
    fs: { strict: true }
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


function devCompatibilityPlugin(): Plugin {
  return {
    name: 'lightweight-cad-viewer:dev-compatibility-routes',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split('?')[0];
        if (pathname !== '/dist/index.js') {
          next();
          return;
        }
        // Compatibility shim for stale/hand-written demo pages that still load
        // /dist/index.js. The source demo entry is /demo/main.ts; library builds
        // create a real dist/index.js through scripts/copy-dist-assets.cjs.
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.end("import '/demo/main.ts';\n");
      });
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
