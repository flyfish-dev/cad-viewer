# 格式支持说明

## DWG

DWG 是专有二进制 CAD 数据库格式。本项目默认使用 `@mlightcad/libredwg-web`，即 LibreDWG 的浏览器 WebAssembly 包装。

DWG loader 被隔离在 `DwgLoader` 后面，因此后续可以替换成其他 parser，或替换成授权转换服务。

渲染完整度取决于 parser 暴露出的归一化实体。默认 renderer 覆盖常见 2D 基础实体，并在 block 定义可用时展开 INSERT。DWG 链路会保留 active VPORT/header UCS saved view、块内文字的宽度因子/对齐/镜像属性、常量和顶点多段线宽度、LTYPE 定义、线型缩放及 converter 特有的闭合多段线 flag。安全的平面 saved view 只应用一次；文字和 INSERT 角度会在变换后归一化，非法或倾斜视图则保留 WCS 坐标。Canvas2D 与 WebGL 支持 BYLAYER/BYBLOCK 虚线和点线，并在多段线边之间保持线型相位。

复杂线型中的 SHX shape 并不会把轮廓嵌入 DWG；图纸引用的外部字体会列在 `document.metadata.requiredShxFonts`，未解析项列在 `document.metadata.missingReferences`。应用可以通过 `CadViewer.addReference*()` 传入用户选择的本地 `File`，也可以传入业务 API 提供的 `ArrayBuffer`/`Uint8Array`。Canvas2D 与 WebGL 随后会按原始缩放、局部 X/Y 偏移及相对/绝对旋转绘制解码后的 shape/text 轮廓。兼容文件尚未提供时，renderer 会保留 dash/gap 长度和相位，并使用 marker fallback；要获得准确符号外观仍需要原始 SHX。

## DXF

DXF 由 `DxfLoader` 处理：优先使用 `dxf-parser`，失败时使用内置 fallback 解析常见 DXF `ENTITIES`。文本解码会识别显式 `dxfEncoding`、BOM 和 `$DWGCODEPAGE`，再进入 legacy 候选 fallback。

支持预览：

- LINE、CIRCLE、ARC。
- LWPOLYLINE、POLYLINE、bulge 圆弧。
- ELLIPSE、SPLINE 预览。
- TEXT、MTEXT、ATTRIB，并处理 `\U+XXXX`、`%%c`、`%%d`、`%%p`、`\P` 等常见 CAD 文本转义。
- INSERT 块引用。
- SOLID、TRACE、3DFACE。
- HATCH boundary loop 预览。

## DWF / DWFx / XPS

DWF、DWFx 和 XPS 由 `DwfLoader` 通过已发布的 `dwf-viewer` 包处理。该链路使用 native renderer，不再把 DWF 内容简化成 DWG/DXF 的 2D 场景模型。

覆盖的渲染路径包括：

- DWF 6+ ZIP 容器包。
- WHIP/W2D 2D 图纸，支持 WebGL 渲染、自适应 CAD 线宽和可选 WASM raster fallback。
- W3D/HSF 3D eModel shell geometry，包含模型树和材质元数据。
- DWFx / OPC / XPS `FixedPage` 页面，包含 WebGL 加速矢量、浏览器允许 `FontFace` 时的 XPS 嵌入字体、文本和图片资源。

`CadViewer` 会识别 native DWF loader，并将其挂载到 `nativeHost`；DWG/DXF 继续走统一 `CadDocument` + retained WebGL renderer。部署时请把 `dwg-worker.js`、`libredwg-web.js`、`libredwg-web.wasm` 和 `dwfv-render.wasm` 一起放在 `/wasm` 下，或显式传入 `workerUrl` / `dwfWasmUrl`。DWF/XPS 总览渲染可以通过 `dwfLineWeightMode`、`dwfMinStrokeCssPx`、`dwfMaxOverviewStrokeCssPx`、`dwfMinTextCssPx`、`dwfMinFilledAreaCssPx` 调节。
