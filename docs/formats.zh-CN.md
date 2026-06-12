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

## DWF / DWFx / XPS

DWF、DWFx 和 XPS 由 `DwfLoader` 通过已发布的 `dwf-viewer` 包处理。该链路使用 native renderer，不再把 DWF 内容简化成 DWG/DXF 的 2D 场景模型。

覆盖的渲染路径包括：

- DWF 6+ ZIP 容器包。
- WHIP/W2D 2D 图纸，支持 WebGL 渲染和可选 WASM raster fallback。
- W3D/HSF 3D eModel shell geometry，包含模型树和材质元数据。
- DWFx / OPC / XPS `FixedPage` 页面，包含矢量、文本和图片资源。

`CadViewer` 会识别 native DWF loader，并将其挂载到 `nativeHost`；DWG/DXF 继续走统一 `CadDocument` + retained WebGL renderer。部署时请把 `dwfv-render.wasm` 与 `libredwg-web.wasm` 一起放在 `/wasm` 下，或显式传入 `dwfWasmUrl`。
