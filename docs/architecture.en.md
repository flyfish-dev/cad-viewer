# Architecture

Lightweight CAD Viewer is intentionally split into three layers: format loaders, normalized scene data, and rendering.

## Goals

- Keep DWG, DXF and DWF parsing isolated.
- Avoid format-specific assumptions inside renderers; WebGL and Canvas2D are interchangeable.
- Surface parser diagnostics and skipped entity counts without interrupting preview.
- Keep the default WebGL renderer lightweight and framework-independent with a Canvas2D fallback.

## Data flow

```text
File / ArrayBuffer
  ↓
CadLoaderRegistry.detect()
  ↓
DWG: DwgLoader.load() → DwgWorkerClient → DwgWorker → LibreDWG WASM
DXF: DxfLoader.load() → CadDocument
DWF/DWFx/XPS: DwfLoader.mount() → dwf-viewer native renderer
  ↓
DWG: WCS CadDocument + LTYPE/saved view → safe scene transform → retained WebGL batches + Canvas overlay
DXF: CadDocument → retained WebGL batches + Canvas overlay
DWF/DWFx/XPS: W2D/XPS WebGL vectors + W3D/HSF 3D + Canvas text/image overlay + optional WASM fallback
External SHX File / bytes → CadShxFontRegistry → validated glyph cache → Canvas2D/WebGL linetype rebuild
```

## Key modules

```text
src/core/types.ts       public data model
src/core/color.ts       ACI / true color / BYLAYER resolution
src/core/geometry.ts    CAD geometry helpers
src/core/bom.ts         bounded BOM/property extraction and CSV/JSON serialization
src/core/linetype.ts    LTYPE resolution, inheritance and dash/dot expansion
src/core/shx.ts         external SHX parsing, validation, cache and reference state
src/core/scene.ts       saved-view scene normalization
src/core/transform.ts   block insert, saved-view and XPS matrix transforms
src/loaders/            loader registry and default loaders
src/loaders/dwg/        worker-backed LibreDWG integration
src/loaders/dwf/        native dwf-viewer integration
src/viewer/             component, WebGL renderer and Canvas fallback
```


## WebGL rendering model

`CadWebGLRenderer` is the default rendering path. It builds a retained scene once in `setDocument()` instead of traversing all entities on every pan or zoom:

```text
CadDocument
  ↓
saved-view transform / block expansion / curve tessellation / linetype expansion / fill triangulation
  ↓
Float32Array positions + Uint8Array colors
  ↓
spatial batch upload
  ↓
per-frame view uniform update + visible batch draw
```

Core performance choices:

- Coordinates are stored relative to the drawing center to reduce Float32 precision loss with large CAD coordinates.
- Lines, fills and points are uploaded separately; colors use normalized `Uint8Array`.
- Geometry is bucketed spatially, so zoomed-in views submit only batches intersecting the viewport.
- Polylines with constant or per-vertex widths are expanded into triangles in the retained WebGL scene; Canvas2D uses the same world-unit width semantics.
- DWG line patterns keep world-unit phase across polyline edges. Supplied SHX shape/text glyphs honor authored scale, local offset and relative/absolute rotation; zero-length dots and unavailable glyphs use screen-space markers.
- Text and images are kept out of the main GPU geometry stream and drawn through an overlay with size/count limits; block-contained TEXT width factors, alignment points, generation flags and transformed angles are preserved.
- When WebGL is unavailable, `renderer: 'auto'` falls back to `CadCanvasRenderer`.

## DWG worker model

DWG is the heaviest path, so it is worker-backed by default. The packaged worker is built as a stable runtime asset and loaded from `wasm/dwg-worker.js` by default, resolved relative to the page URL:

```text
main thread
  CadViewer.loadFile(file)
  CadLoaderRegistry detects DWG
  DwgWorkerClient transfers bytes
      ↓
worker thread
  DwgWorker imports @mlightcad/libredwg-web
  LibreDWG WASM is initialized and cached
  dwg_read_data() + convert()
  normalizeDwgDatabase()
      ↓
main thread
  receive CadDocument
  WebGL render
```

The worker payload intentionally excludes raw parser objects by default. That keeps messages structured-clone-safe and avoids doubling memory use for large drawings. Use `keepRaw: true` only for debugging.

The loader accepts `AbortSignal`, `workerTimeoutMs`, `workerUrl` and `workerFactory`, so applications can cancel large files and integrate with custom bundler/CDN asset layouts. Serve `dwg-worker.js` beside the `/wasm` runtime assets or pass `workerUrl` explicitly.

## BOM extraction model

BOM extraction runs on the parser-owned source document, not on transformed render geometry. `extractCadBom()` keeps different schedules as separate typed tables and applies row, cell, entity and recursion limits. Application-defined XDATA and XRECORD containers are available through explicit `sources` selection and stay out of the default BOM to avoid exposing internal CAD caches as parts tables.

```text
DWG / DXF source CadDocument
  ├─ INSERT / MINSERT → ATTDEF defaults + ATTRIB instance values
  ├─ ACAD_TABLE / TABLE → cells cached in the drawing
  ├─ DataTable / XDATA / XRECORD → typed property tables
  └─ aligned TEXT / MTEXT → high-confidence text-grid fallback
      ↓
CadBom → serializeCadBomCsv() / serializeCadBomJson()
```

DataLink records are metadata only. The library never follows a connection string or reads an external workbook; only values already present in the drawing can be returned. Missing modern table payloads are reported as warnings. The native DWF renderer currently has no normalized component/property model, so it does not produce BOM tables.

## External SHX reference model

LibreDWG normalization preserves each complex LTYPE element's STYLE handle and resolves it to an SHX file name. `CadShxFontRegistry` stays on the main thread and outside `CadDocument`, so third-party parser instances never enter Worker messages or public serializable scene data.

```text
CadDocument LTYPE + metadata.requiredShxFonts
  ↓
CadShxFontRegistry.setDocument()
  ↓
missing/loaded state + required-glyph validation
  ↓ addReferenceFile() / addReferenceBuffer()
@mlightcad/shx-parser → normalized, cached polylines
  ↓
Canvas2D immediate redraw / WebGL retained-scene rebuild with view state preserved
```

References may be registered before or after a drawing. File names are matched case-insensitively by basename; same-named files that do not contain required shape/text codes remain `incompatible`. Missing resources are mirrored to `document.metadata.missingReferences` and reported through `onReferenceStateChange`. Loaded parsers are released on replacement, removal, `clearReferences()` or `destroy()`.


## Native DWF renderer model

DWF, DWFx and XPS use a native-renderable loader because W2D, W3D/HSF eModel and XPS package content cannot be faithfully represented by the lightweight 2D `CadDocument` scene alone.

```text
main thread
  CadViewer.loadFile(file)
  CadLoaderRegistry detects DWF/DWFx/XPS
  DwfLoader.mount(input, nativeHost)
      ↓
  dwf-viewer parses DWF package/page streams
  WebGL draws W2D and XPS/DWFx vectors; Canvas overlays text/images; WASM fallback is available for complex 2D pages
      ↓
  CadViewer still exposes summary, metadata and lifecycle controls
```

`DwfLoader.load()` remains available for programmatic metadata reads. `CadViewer` uses `mount()` when a loader implements `CadNativeRenderableLoader`. This keeps native format renderers isolated without weakening the loader registry contract. The DWF path passes through `dwf-viewer` controls for WebGL/WASM preference, cache budgets, adaptive line weights and dense-overview text/fill thresholds.

## Loader contract

Every loader implements:

```ts
interface CadLoader {
  id: string;
  label: string;
  formats: CadFormat[];
  accepts(input: CadLoadInput, bytes?: Uint8Array): boolean;
  load(input: CadLoadInput, options?: CadLoadOptions): Promise<CadLoadResult>;
}

interface CadNativeRenderableLoader extends CadLoader {
  nativeRenderer: true;
  mount(input: CadLoadInput, host: HTMLElement, options?: CadLoadOptions): Promise<CadLoadResult>;
  unmount(): void;
}
```

Regular loaders return a `CadDocument`, not renderer-specific draw calls. Native-renderable loaders can additionally implement `mount()` when their format needs a dedicated DOM/WebGL viewer.

## Normalized scene

A `CadDocument` contains:

- `layers`: normalized layer metadata.
- `lineTypes`: normalized LTYPE definitions, indexed by name and handle.
- `blocks`: reusable block definitions.
- `entities`: top-level entities.
- `pages`: optional page entities and native-renderer metadata.
- `savedView`: active VPORT or header-UCS view metadata and its safe 2D scene transform.
- `dataLinks`, `dataTables`, `xrecords`, `dictionaries`: optional business-data records exposed by the source parser.
- `warnings`: non-fatal parsing or rendering limitations.
- `raw`: optional source parser output for debugging.

For DWG, `getSourceDocument()` returns the parser-owned WCS document. `getDocument()` returns the render scene after a safe planar saved-view transform. Invalid, missing or tilted `VIEWDIR` values leave WCS coordinates unchanged and add a warning.

Bounds are split into two responsibilities: full scene extents remain available for culling, inspection and `fit('extents')`, while the default automatic fit intersects entity bounds with a valid active VPORT and tightens to meaningful visible content. This keeps remote but valid coordinate clusters available without shrinking the initial sheet view into a dot.

## Renderer coverage

The default WebGL renderer supports common preview geometry:

- LINE, CIRCLE, ARC, LWPOLYLINE, POLYLINE.
- ELLIPSE, SPLINE preview polyline.
- TEXT, MTEXT, ATTRIB, DIMENSION text fallback.
- INSERT block expansion with translation/rotation/scale and composed text, line-width and linetype-scale semantics.
- SOLID, TRACE, 3DFACE.
- HATCH loop preview.

## Color strategy

CAD color is resolved at render time so BYLAYER and theme foreground can be honored.

Resolution order:

1. explicit CSS/true color object,
2. true color integer above 257,
3. entity ACI fields,
4. layer ACI / true color,
5. viewer foreground.

This avoids the common bug where ACI values in `color` are treated as 24-bit RGB. ACI 7 follows the viewer foreground, and `contrastMode: 'adaptive'` can lift or darken low-contrast colors against the current canvas background.
