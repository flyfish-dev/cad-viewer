# Architecture

Lightweight CAD Viewer is intentionally split into three layers: format loaders, normalized scene data, and rendering.

## Goals

- Keep DWG, DXF and DWF parsing isolated.
- Avoid format-specific assumptions inside renderers; WebGL and Canvas2D are interchangeable.
- Make unsupported entities visible in diagnostics instead of silently failing.
- Keep the default WebGL renderer lightweight and framework-independent with a Canvas2D fallback.

## Data flow

```text
File / ArrayBuffer
  ↓
CadLoaderRegistry.detect()
  ↓
DwgLoader.load() / DxfLoader.load() / DwfLoader.load()
  ↓
DWG only: DwgWorkerClient → DwgWorker → LibreDWG WASM
  ↓
CadDocument
  ↓
CadWebGLRenderer.setDocument()
  ↓
retained GPU batches + Canvas overlay
  ↓
WebGL preview
```

## Key modules

```text
src/core/types.ts       public data model
src/core/color.ts       ACI / true color / BYLAYER resolution
src/core/geometry.ts    CAD geometry helpers
src/core/transform.ts   block insert and XPS matrix transforms
src/loaders/            loader registry and default loaders
src/loaders/dwg/        worker-backed LibreDWG integration
src/viewer/             component, WebGL renderer and Canvas fallback
```


## WebGL rendering model

`CadWebGLRenderer` is the default rendering path. It builds a retained scene once in `setDocument()` instead of traversing all entities on every pan or zoom:

```text
CadDocument
  ↓
block expansion / curve tessellation / fill triangulation
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
- Text and images are kept out of the main GPU geometry stream and drawn through an overlay with size/count limits.
- When WebGL is unavailable, `renderer: 'auto'` falls back to `CadCanvasRenderer`.

## DWG worker model

DWG is the heaviest path, so it is worker-backed by default:

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

The loader accepts `AbortSignal`, `workerTimeoutMs`, `workerUrl` and `workerFactory`, so applications can cancel large files and integrate with custom bundler/CDN asset layouts.

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
```

Loaders should return a `CadDocument`, not renderer-specific draw calls. That keeps WebGL, Canvas2D, SVG export and thumbnail renderers on the same data layer.

## Normalized scene

A `CadDocument` contains:

- `layers`: normalized layer metadata.
- `blocks`: reusable block definitions.
- `entities`: top-level entities.
- `pages`: optional page entities for DWFx/XPS.
- `warnings`: non-fatal parsing or rendering limitations.
- `raw`: optional source parser output for debugging.

## Renderer coverage

The default WebGL renderer supports common preview geometry:

- LINE, CIRCLE, ARC, LWPOLYLINE, POLYLINE.
- ELLIPSE, SPLINE preview polyline.
- TEXT, MTEXT, ATTRIB, DIMENSION text fallback.
- INSERT block expansion with translation/rotation/scale.
- SOLID, TRACE, 3DFACE.
- HATCH loop preview.
- DWFx/XPS PATH, Glyphs and image placeholders.

## Color strategy

CAD color is resolved at render time so BYLAYER and theme foreground can be honored.

Resolution order:

1. explicit CSS/true color object,
2. true color integer above 257,
3. entity ACI fields,
4. layer ACI / true color,
5. viewer foreground.

This avoids the common bug where ACI values in `color` are treated as 24-bit RGB. ACI 7 follows the viewer foreground, and `contrastMode: 'adaptive'` can lift or darken low-contrast colors against the current canvas background.
