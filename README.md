# @flyfish-dev/cad-viewer

A professional, lightweight, extensible **frontend CAD viewer** for modern browsers.

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-b31b1b.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@flyfish-dev/cad-viewer.svg)](https://www.npmjs.com/package/@flyfish-dev/cad-viewer)

**Live demo:** [cad-viewer-iys.pages.dev](https://cad-viewer-iys.pages.dev)  
**Source:** [github.com/flyfish-dev/cad-viewer](https://github.com/flyfish-dev/cad-viewer)

The project provides a clean loader architecture for **DWG**, **DXF** and **DWFx/XPS-compatible DWF preview**, normalizes format-specific data into a common `CadDocument`, and renders it through a retained WebGL pipeline with a lightweight Canvas overlay for text and images. Files are read locally in the browser; the viewer does not upload drawings to a backend.

> DWG support uses `@mlightcad/libredwg-web` / LibreDWG WebAssembly. DXF support uses JavaScript parsing plus a built-in fallback parser. DWFx support parses XPS `FixedPage` vector pages. Classic `.dwf` WHIP/W2D/W3D streams are detected and reported clearly, but full classic DWF decoding still requires a dedicated WHIP decoder or DWF Toolkit/WASM implementation.


## What changed in 0.5.3

- Fixed DWG color fidelity for layer-indexed drawings. Indexed LibreDWG layers now resolve from ACI instead of the converter placeholder `0xffffff`, preventing monochrome-white output.
- Preserved DWG true-color values even when the RGB integer is in the ACI range, such as `0x0000ff`.
- Added BYBLOCK color inheritance for expanded INSERT/block entities.

## What changed in 0.5.2

- Fixed the noisy Vite build output where `@mlightcad/libredwg-web` printed a multi-megabyte `data:application/wasm;base64,...` warning.
- DWG worker builds now use the lean LibreDWG ESM wrapper and load `/wasm/libredwg-web.js` + `/wasm/libredwg-web.wasm` at runtime, avoiding duplicated inline wasm assets.
- `build:lib` now creates `dist/index.js` as a compatibility re-export for integrations that still request `/dist/index.js`.
- Vite dev mode now serves a small `/dist/index.js` compatibility shim that forwards stale demo pages to `/demo/main.ts`.
- `npm run preview` now builds the demo first, so clean checkouts do not fail because `dist-demo` is missing.

## What changed in 0.5

- The default rendering backend is now a **retained WebGL renderer**. CAD primitives are flattened once and uploaded to GPU buffers; pan/zoom updates only view uniforms.
- Added spatial indexing and viewport culling. Line, triangle and point batches are bucketed across the drawing bounds, so zoomed-in views submit only visible batches.
- Added large-drawing memory controls: coordinates are stored relative to the drawing center in `Float32Array`, colors are stored in `Uint8Array`, and temporary CPU arrays are released after upload.
- Text and images render in a separate overlay with minimum screen-height and maximum visible-label limits.
- `CadViewer` now supports `renderer: 'auto' | 'webgl' | 'canvas2d'`; `auto` prefers WebGL and falls back to Canvas2D.
- Demo now reports renderer backend, visible primitives and estimated GPU memory.

## What changed in 0.4

- DWG parsing now runs in a **dedicated Web Worker by default**, so LibreDWG WASM initialization and binary decoding no longer block pan/zoom/UI interactions.
- The worker keeps the LibreDWG WASM instance warm and reuses it across DWG loads.
- Added cancellable loading through `AbortSignal`, worker timeout support, progress events, and explicit worker asset configuration.
- Reduced DWG memory pressure by stripping raw parser objects from worker payloads unless `keepRaw: true` is explicitly enabled.
- Demo now includes a loading overlay, progress bar, cancel action and loader mode indicator.
- `viewer.destroy()` disposes canvas listeners and terminates owned DWG workers, which is safe for SPA route changes.
- Library exports `supportsDwgWorker` and `DwgWorkerClient` for advanced integrations.

## Features

- **Pure frontend viewer component**: `new CadViewer({ container })` or `new CadViewer({ canvas })`.
- **Loader registry**: DWG, DXF and DWF loaders are independent and replaceable.
- **DWG preview**: browser-local parsing through LibreDWG WebAssembly, executed in a Web Worker by default.
- **DXF preview**: JavaScript parser path with fallback support for common ASCII DXF `ENTITIES`.
- **DWF/DWFx preview**: DWFx/XPS 2D `FixedPage` rendering for paths, glyphs and images.
- **CAD color handling**: ACI, BYLAYER, BYBLOCK inheritance, DWG layer colors, true color, fill color, opacity and adaptive contrast.
- **High-performance WebGL viewport controls**: retained GPU buffers, spatial culling, zoom, pan, fit-to-view, cursor world coordinates and zoom percentage.
- **Professional demo UI**: drag-and-drop, compact toolbar, status strip, parse/render timing, entity summary and warnings.
- **Library + demo builds**: publishable npm package and Cloudflare Pages demo.

## Install

```bash
npm install @flyfish-dev/cad-viewer
```

For local development from this repository:

```bash
npm install
npm run dev
```

The DWG loader needs LibreDWG WASM assets in a public directory. This repository copies and validates them for the demo:

```bash
npm run copy:wasm
npm run check:wasm
```

The demo resolves `wasmPath` to an absolute URL before sending it to the worker. In your own app, prefer an absolute path or URL, for example `/wasm` or `new URL('wasm/', document.baseURI).href`. Avoid passing a worker-relative path such as `./wasm` unless it is resolved on the UI thread first.

When publishing the npm package, `build:lib` also copies these files into `dist/wasm` and exposes them as package subpaths. Applications still need to serve the `.wasm` from a public URL and pass that directory as `wasmPath`.


## Demo startup notes

Use Vite for the source demo:

```bash
npm install
npm run dev
```

For a production preview, use:

```bash
npm run preview
```

Do not serve the source directory with a plain static server and expect TypeScript entries to run. If a stale page requests `/dist/index.js`, run `npm run build:lib` to create the compatibility entry, or use the Vite dev server above.

## Basic usage

```ts
import { CadViewer } from '@flyfish-dev/cad-viewer';
import '@flyfish-dev/cad-viewer/style.css';

const viewer = new CadViewer({
  container: document.querySelector('#viewer')!,
  renderer: 'auto',       // WebGL first, Canvas2D fallback
  wasmPath: new URL('wasm/', document.baseURI).href,
  canvasOptions: {
    background: '#05070d',
    foreground: '#f8fafc',
    contrastMode: 'adaptive',
    minColorContrast: 2.45
  }
});

const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
input.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;
  await viewer.loadFile(file);
});
```


## WebGL rendering and performance model

The default `renderer: 'auto'` path attempts to create `CadWebGLRenderer` first. Instead of traversing every entity and rebuilding Canvas2D paths on every zoom, the renderer builds a retained scene once in `setDocument()`:

```text
CadDocument
  ↓
flatten blocks / curves / fills
  ↓
Float32Array positions + Uint8Array colors
  ↓
spatial GPU batches
  ↓
WebGL drawArrays with viewport culling
```

Tunable options:

```ts
new CadViewer({
  container,
  renderer: 'auto', // force 'webgl' or 'canvas2d' when needed
  canvasOptions: {
    enableSpatialIndex: true,
    spatialIndexCellCount: 96,
    maxVerticesPerBatch: 32768,
    maxCurveSegments: 72,
    textMinPixelHeight: 4,
    maxVisibleTextLabels: 2400,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false
  },
  onRenderStats(stats) {
    console.log(stats.backend, stats.visiblePrimitiveCount, stats.gpuMemoryBytes);
  }
});
```

For very large drawings, lower `maxCurveSegments`, increase `spatialIndexCellCount`, and cap `maxVisibleTextLabels`.

## Worker-backed DWG parsing

`DwgLoader` uses a module Web Worker by default in browsers. The worker imports `@mlightcad/libredwg-web`, initializes LibreDWG WASM inside the worker thread, caches that WASM instance, decodes DWG bytes, normalizes the result into a structured-clone-safe `CadDocument`, and sends only the normalized scene back to the UI thread. Canvas rendering remains on the main thread.

```ts
const controller = new AbortController();

const viewer = new CadViewer({
  container,
  wasmPath: new URL('wasm/', document.baseURI).href,
  useWorker: true,
  workerTimeoutMs: 120_000,
  onLoadProgress(progress) {
    console.log(progress.phase, progress.message, progress.percent);
  }
});

await viewer.preloadDwg(); // optional: warm the worker before the first file
await viewer.loadFile(file, { signal: controller.signal });

// cancel a large DWG load
controller.abort();
```

Advanced deployments can override the worker constructor when the bundler or CDN has a custom asset layout:

```ts
new CadViewer({
  container,
  wasmPath: new URL('wasm/', document.baseURI).href,
  workerUrl: new URL('/assets/dwg-worker.js', window.location.origin)
});
```

The default package is worker-first. For non-browser runtimes, register a custom DWG loader instead of disabling workers.

## Component API

```ts
const viewer = new CadViewer({
  container,             // HTMLElement; creates a canvas inside
  canvas,                // optional existing HTMLCanvasElement
  renderer: 'auto',      // 'auto' | 'webgl' | 'canvas2d'
  wasmPath: '/wasm',     // LibreDWG WebAssembly asset path. Absolute URL/path recommended for workers
  autoFit: true,
  canvasOptions: {
    background: '#05070d',
    foreground: '#ffffff',
    contrastMode: 'adaptive',       // 'adaptive' | 'preserve'
    minColorContrast: 2.45,
    showPageBounds: true,
    showUnsupportedMarkers: false,
    trueColorByteOrder: 'rgb',
    enableSpatialIndex: true,
    spatialIndexCellCount: 96,
    maxVerticesPerBatch: 32768,
    maxCurveSegments: 72,
    textMinPixelHeight: 4,
    maxVisibleTextLabels: 2400
  },
  useWorker: true,                 // default for DWG
  workerTimeoutMs: 0,              // 0 = disabled
  onLoadProgress(progress) {},
  onLoad(result) {},
  onError(error) {},
  onRenderStats(stats) {},
  onViewChange(event) {}
});

await viewer.loadFile(file);
await viewer.loadBuffer(arrayBuffer, 'drawing.dxf');
viewer.fit();
viewer.zoomIn();
viewer.zoomOut();
await viewer.preloadDwg();       // optional DWG worker/WASM warmup
viewer.setCanvasOptions({ background: '#f7f8fb', foreground: '#111827' });
viewer.clear();
viewer.destroy();
```

## Loader architecture

```text
File / ArrayBuffer
  ↓
CadLoaderRegistry
  ↓
DwgLoader | DxfLoader | DwfLoader | custom loader
  ↓
CadDocument
  ↓
CadWebGLRenderer | CadCanvasRenderer fallback
  ↓
WebGL preview + Canvas overlay
```

Each loader returns a normalized `CadDocument`:

```ts
interface CadDocument {
  format: 'dwg' | 'dxf' | 'dwf' | 'dwfx' | 'xps' | 'unknown';
  layers: Record<string, CadLayer>;
  blocks: Record<string, CadBlock>;
  entities: CadEntity[];
  pages?: CadPage[];
  warnings: string[];
  raw?: unknown;
}
```

Register a custom loader:

```ts
viewer.registerLoader({
  id: 'my-cad-format',
  label: 'My CAD Format',
  formats: ['unknown'],
  accepts(input) {
    return input.fileName?.endsWith('.cad') ?? false;
  },
  async load(input) {
    return {
      document: {
        format: 'unknown',
        layers: {},
        blocks: {},
        entities: [],
        metadata: {},
        warnings: []
      },
      bytes: input.buffer instanceof Uint8Array ? input.buffer.byteLength : 0,
      elapsedMs: 0,
      format: 'unknown',
      warnings: []
    };
  }
});
```

## Format support

| Format | Loader | Coverage |
|---|---|---|
| DWG | `DwgLoader` | Uses LibreDWG WebAssembly. Rendering coverage depends on the entities exposed by LibreDWG conversion. |
| DXF | `DxfLoader` | Uses `dxf-parser` plus fallback parsing. Supports core entities, blocks/inserts, colors/layers, polylines, text, hatch boundaries and splines as preview polylines. |
| DWFx / XPS | `DwfLoader` | Parses ZIP/OPC packages and renders 2D `FixedPage` path/glyph/image content. |
| Classic DWF | `DwfLoader` detection | Detects WHIP/W2D/W3D package content and returns a clear unsupported error. Full classic DWF requires a dedicated WHIP decoder or DWF Toolkit/WASM. |

## Color handling

The color resolver follows CAD semantics instead of treating all numbers as RGB:

1. explicit CSS color or true color object,
2. explicit DWG true-color integer, including low RGB values such as `0x0000ff`,
3. entity ACI (`colorIndex`, `colorNumber`, `color` in `1..255`),
4. BYBLOCK inheritance (`0`) when expanding INSERT/block geometry,
5. BYLAYER lookup (`256` / unset),
6. viewer foreground fallback.

Layer colors prefer a valid ACI index when a converter also exposes a placeholder RGB value. ACI `7` is foreground-dependent: it renders light on dark canvas and dark on light canvas. With `contrastMode: 'adaptive'`, colors too close to the current canvas background are adjusted just enough to stay readable. Use `contrastMode: 'preserve'` when exact plotted colors are more important than screen readability.

If a particular converter exposes true-color integers in BGR order:

```ts
new CadViewer({ canvasOptions: { trueColorByteOrder: 'bgr' } });
```

## Development

```bash
npm install
npm run dev          # run the demo
npm run typecheck    # TypeScript validation
npm run build        # library + demo
npm run preview      # preview built demo
```

## npm publishing

1. Build and inspect the package:

```bash
npm run build:lib
npm run pack:dry
```

2. Publish:

```bash
npm login
npm publish --access public
```

The package also exposes:

```bash
npm run release:npm
```

## Cloudflare Pages publishing

Direct upload with Wrangler. The repository includes `public/_headers`, so Cloudflare Pages serves `.wasm` as `application/wasm` and caches it long-term:

```bash
npm install
npm run build:demo
npx wrangler pages deploy dist-demo --project-name cad-viewer
```

Or use the included script:

```bash
npm run deploy:pages
```

For GitHub Actions, configure repository secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

The workflow is included at `.github/workflows/pages.yml`.

## Repository layout

```text
src/
  core/          shared format detection, colors, geometry, transforms, normalized types
  loaders/       DwgLoader, DxfLoader, DwfLoader and CadLoaderRegistry
  viewer/        CadViewer component and Canvas renderer
demo/            professional Vite demo UI
docs/            English and Chinese architecture / format notes
scripts/         clean and LibreDWG WASM copy helpers
public/wasm/     demo WASM asset output directory
```

## License

AGPL-3.0-only. This is a strict copyleft license: if you distribute modified versions or offer modified versions over a network, review your source-code disclosure obligations carefully.

The default DWG loader depends on `@mlightcad/libredwg-web`, which is GPL-3.0-only. For closed-source commercial use, replace the DWG loader with a properly licensed parser/converter and review all dependency licenses.
