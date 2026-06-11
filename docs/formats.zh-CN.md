# 格式支持说明

## DWG

DWG 是专有二进制 CAD 数据库格式。本项目默认使用 `@mlightcad/libredwg-web`，即 LibreDWG 的浏览器 WebAssembly 包装。

DWG loader 被隔离在 `DwgLoader` 后面，因此后续可以替换成其他 parser，或替换成授权转换服务。

渲染完整度取决于 parser 暴露出的归一化实体。默认 renderer 覆盖常见 2D 基础实体，并在 block 定义可用时展开 INSERT。

## DXF

DXF 由 `DxfLoader` 处理：优先使用 `dxf-parser`，失败时使用内置 fallback 解析常见 ASCII DXF `ENTITIES`。

支持预览：

- LINE、CIRCLE、ARC。
- LWPOLYLINE、POLYLINE、bulge 圆弧。
- ELLIPSE、SPLINE 预览。
- TEXT、MTEXT、ATTRIB。
- INSERT 块引用。
- SOLID、TRACE、3DFACE。
- HATCH boundary loop 预览。

## DWF / DWFx

DWFx 基于 XPS/OPC 包。本项目默认 DWF loader 读取 ZIP 包并渲染 2D `FixedPage` 内容：

- `Path Data` 渲染为 Canvas path。
- `Glyphs` 渲染为文字。
- `ImageBrush` 渲染为内嵌图片或占位框。
- 支持基础 matrix transform。

经典 DWF 通常将图形存储在 WHIP/W2D/W3D 流里。本项目会检测这些流并给出明确 unsupported error。完整经典 DWF 需要 WHIP 解码器或 Autodesk/ODA DWF Toolkit，通常需要 WASM 或转换服务。
