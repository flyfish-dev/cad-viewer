# Changelog

## 0.6.2

### Changed

- Updated `dwf-viewer` to 0.6.4 to pick up upstream DWF/DWFx bug fixes.
- Kept the existing `CadViewer` DWF/XPS options aligned with the 0.6.4 `DwfViewerOptions` and `LoadOptions` API.

## 0.6.1

### Added

- Exposed `dwfLineWeightMode`, `dwfMinStrokeCssPx`, `dwfMaxOverviewStrokeCssPx`, `dwfMinTextCssPx` and `dwfMinFilledAreaCssPx` so applications can tune `dwf-viewer` 0.6.x CAD overview rendering from `CadViewer` options.

### Changed

- Updated `dwf-viewer` to 0.6.1.
- Aligned package metadata, README and docs with the current DWF path: WebGL-accelerated XPS/DWFx and W2D 2D vector rendering, W3D/HSF 3D rendering, embedded XPS fonts, adaptive line weights and optional WASM raster fallback.

## 0.6.0

### Added

- Integrated the published `dwf-viewer` package as the native DWF/DWFx/XPS rendering path.
- Added `CadNativeRenderableLoader` so complex formats can mount a dedicated DOM/WebGL renderer while staying inside the loader registry.
- Added native DWF options: `dwfWasmUrl`, `dwfPreferWebgl`, `dwfPreferWasm`, `dwfBackground`, `dwfMaxDevicePixelRatio`, `dwfMaxCanvasPixels`, `dwfMaxGpuCacheBytes` and `dwfMaxCachedScenes`.
- Added runtime asset copying and validation for `dwfv-render.wasm` beside `libredwg-web.wasm`.

### Changed

- Replaced the previous DWFx/XPS subset parser with `dwf-viewer` native rendering for DWF 6+ ZIP packages, WHIP/W2D sheets, W3D/HSF eModel content and DWFx/OPC/XPS pages.
- DWF/DWFx/XPS loads now use `DwfLoader.mount()` and a dedicated native host; DWG/DXF continue through `CadDocument` + retained WebGL.
- Package license updated to AGPL-3.0-only due to the integrated DWF renderer.

### Removed

- Removed the old classic-DWF limitation message path.
- Removed the direct `fflate` dependency from this package.

## 0.5.3

### Fixed

- Restored DWG layer/entity color fidelity for files whose visible colors are carried by ACI layer indices. LibreDWG can expose indexed layer colors together with a placeholder numeric `color: 0xffffff`; the viewer now prefers the layer ACI index in that case instead of rendering the drawing monochrome white.
- Preserved DWG entity true-color values even when the numeric RGB value is less than or equal to 255, avoiding accidental ACI interpretation for low RGB values such as `0x0000ff`.
- Added BYBLOCK color inheritance when expanding INSERT/block geometry, so child entities with color index `0` inherit the inserted block reference color.

## 0.5.2

### Fixed

- Removed the huge Vite build warning caused by the upstream LibreDWG package root embedding a `data:application/wasm;base64,...` fallback. The viewer now aliases LibreDWG to the lean ESM wrapper and loads the official runtime glue from `wasmPath` at runtime.
- Prevented Vite from emitting a duplicated LibreDWG `.wasm` asset into the worker chunk. The worker fetches exactly the `libredwg-web.wasm` served from `wasmPath`, validates its magic bytes, and passes it to Emscripten as `wasmBinary`.
- Added a `dist/index.js` compatibility entry during library builds for integrations that still request `/dist/index.js`.
- Added a Vite dev-server compatibility route for `/dist/index.js`, forwarding stale demo pages to `/demo/main.ts` instead of returning 404.
- Changed `npm run preview` to build the demo before starting Vite preview, so a clean checkout can preview without a manual `build:demo` step.

## 0.5.1

### Fixed

- Fixed DWG worker WASM asset resolution when `wasmPath` is relative, so `./wasm` is resolved relative to the page instead of the generated worker chunk.
- Avoided Emscripten streaming-instantiation MIME failures by loading `libredwg-web.wasm` explicitly and passing it as `wasmBinary`.
- Added WebAssembly magic-byte validation with a clear error when a server returns SPA fallback HTML instead of the `.wasm` file.
- Added Cloudflare Pages `_headers` for `application/wasm` and long-lived caching.
- Made `copy:wasm` fail fast if the LibreDWG WASM asset is missing or invalid.

## 0.5.0

### Added

- Retained WebGL renderer with GPU line, triangle and point batches.
- Spatial indexing and viewport culling for smooth zoomed-in navigation on large drawings.
- Canvas overlay for text and images with label density limits.
- `renderer: 'auto' | 'webgl' | 'canvas2d'` viewer option.
- Render stats for backend, visible primitives, culled primitives and estimated GPU memory.

### Changed

- Demo defaults to WebGL-first rendering and reports GPU memory / visible primitive metrics.
- Geometry buffers store local-origin Float32 coordinates and Uint8 colors to reduce memory and improve precision.

## 0.4.0

### Added

- Worker-backed DWG loading: `DwgLoader` now uses a module Web Worker by default in browsers.
- `DwgWorkerClient`, `supportsDwgWorker`, `parseDwgBytes`, `createLibreDwg` exports for advanced integrations.
- `CadLoadProgress`, `onLoadProgress`, `AbortSignal`, `workerTimeoutMs`, `workerUrl`, `workerFactory`, `transferInputBuffer` and `keepRaw` load options.
- Demo loading overlay, progress bar, cancel action and loader mode indicator.

### Changed

- LibreDWG WASM initialization now happens inside the worker when worker mode is available.
- DWG worker results strip raw parser objects by default to reduce memory use and avoid structured clone failures.
- Demo defaults to cancellable worker loading for DWG.

### Fixed

- Clear error guidance when the packaged worker URL cannot be resolved in a browser runtime.
- Reduced risk of detaching caller-owned ArrayBuffers by copying non-File inputs before transfer.

## 0.3.0

- Fixed DWG initialization error: `Cannot read properties of undefined (reading 'createByWasmInstance')`.
- Reworked the demo into a compact, professional CAD-style workspace.
- Added separate UI theme and drawing canvas theme toggles.
- Added adaptive CAD color contrast for dark and light backgrounds.
- Added runtime `viewer.setCanvasOptions(...)` for theme and renderer option changes.
- Fixed CSS package export to support both `@flyfish-dev/cad-viewer/style.css` and `@flyfish-dev/cad-viewer/styles.css`.

## 0.2.0

- Reworked the project into a loader-based CAD viewer.
- Added DXF and DWFx/XPS preview loaders.
- Added Canvas renderer improvements for colors, blocks, hatches, splines and page content.

## 0.1.0

- Initial DWG-focused browser viewer prototype using LibreDWG WebAssembly and Canvas2D.
