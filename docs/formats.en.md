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

## DWF / DWFx

DWFx is based on XPS/OPC packaging. The default DWF loader reads ZIP packages and renders 2D `FixedPage` content:

- `Path Data` as Canvas paths.
- `Glyphs` as text.
- `ImageBrush` as embedded image or placeholder.
- Basic matrix transforms.

Classic DWF often stores graphics in WHIP/W2D/W3D streams. This project detects those streams and reports an explicit unsupported error. Full classic DWF coverage requires a WHIP decoder or the Autodesk/ODA DWF Toolkit, normally through WASM or a conversion service.
