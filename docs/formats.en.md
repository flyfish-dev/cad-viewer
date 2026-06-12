# Format support notes

## DWG

DWG is a proprietary binary CAD database. This project uses `@mlightcad/libredwg-web`, a browser WebAssembly wrapper around LibreDWG, as the default DWG loader.

The loader is intentionally isolated behind `DwgLoader`, so it can be replaced with another parser or a licensed conversion backend.

Rendering completeness depends on the normalized entities exposed by the parser. The renderer covers common 2D primitives and block insert expansion when block definitions are available.

## DXF

DXF is handled by `DxfLoader` with `dxf-parser` first and a built-in fallback parser for common ASCII DXF `ENTITIES`.

Supported preview entities include:

- LINE, CIRCLE, ARC.
- LWPOLYLINE, POLYLINE, bulge arcs.
- ELLIPSE, SPLINE preview.
- TEXT, MTEXT, ATTRIB.
- INSERT block references.
- SOLID, TRACE, 3DFACE.
- HATCH boundary loop preview.

## DWF / DWFx / XPS

DWF, DWFx and XPS are handled by `DwfLoader` through the published `dwf-viewer` package. The viewer path is native-rendered instead of being approximated by the DWG/DXF 2D scene renderer.

Covered render paths include:

- DWF 6+ ZIP container packages.
- WHIP/W2D 2D sheets with WebGL rendering and optional WASM raster fallback.
- W3D/HSF 3D eModel shell geometry with model tree and material metadata.
- DWFx / OPC / XPS `FixedPage` pages with vector, text and image resources.

`CadViewer` detects the native DWF loader and mounts it into a `nativeHost`; DWG/DXF continue to use the normalized `CadDocument` + retained WebGL renderer. Serve `dwfv-render.wasm` beside `libredwg-web.wasm` under `/wasm`, or pass `dwfWasmUrl` explicitly.
