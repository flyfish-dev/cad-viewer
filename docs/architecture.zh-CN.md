# 架构说明

Lightweight CAD Viewer 被拆成三层：格式 loader、统一场景数据、渲染器。

## 目标

- DWG、DXF、DWF 解析互相隔离。
- 渲染器不绑定某一种 CAD 文件格式；WebGL 与 Canvas2D 可以互换。
- 解析诊断和跳过实体数量会显式反馈，不中断预览。
- 默认 WebGL renderer 保持轻量、无框架依赖，并带 Canvas2D fallback。

## 数据流

```text
File / ArrayBuffer
  ↓
CadLoaderRegistry.detect()
  ↓
DWG：DwgLoader.load() → DwgWorkerClient → DwgWorker → LibreDWG WASM
DXF：DxfLoader.load() → CadDocument
DWF/DWFx/XPS：DwfLoader.mount() → dwf-viewer native renderer
  ↓
DWG/DXF：retained WebGL batches + Canvas overlay
DWF/DWFx/XPS：W2D/W3D/XPS WebGL/WASM renderer
```

## 核心模块

```text
src/core/types.ts       公共数据模型
src/core/color.ts       ACI / true color / BYLAYER 解析
src/core/geometry.ts    CAD 几何工具
src/core/transform.ts   block insert 与 XPS matrix 变换
src/loaders/            loader registry 与默认 loaders
src/loaders/dwg/        基于 Worker 的 LibreDWG 集成
src/loaders/dwf/        原生 dwf-viewer 集成
src/viewer/             组件、WebGL renderer、Canvas fallback
```


## WebGL 渲染模型

`CadWebGLRenderer` 是默认渲染路径。它在 `setDocument()` 时一次性构建 retained scene，而不是在每次缩放/平移时遍历所有实体：

```text
CadDocument
  ↓
block expansion / curve tessellation / fill triangulation
  ↓
Float32Array positions + Uint8Array colors
  ↓
spatial batch upload
  ↓
每帧只更新 view uniform，并绘制可见 batch
```

关键性能策略：

- 坐标以图纸中心为 origin 存储，降低大坐标 Float32 精度损失。
- 线、面、点分开上传，颜色使用 normalized `Uint8Array`。
- 按图纸范围空间分桶，放大后只提交视口相交 batch。
- 文本和图片不进入 GPU 主几何流，使用 overlay 并做阈值/数量限制。
- WebGL 不可用时，`renderer: 'auto'` 回退到 `CadCanvasRenderer`。

## DWG Worker 模型

DWG 是最重的解析路径，因此默认使用 Worker：

```text
主线程
  CadViewer.loadFile(file)
  CadLoaderRegistry 识别 DWG
  DwgWorkerClient transfer 文件字节
      ↓
Worker 线程
  DwgWorker 导入 @mlightcad/libredwg-web
  初始化并缓存 LibreDWG WASM 实例
  dwg_read_data() + convert()
  normalizeDwgDatabase()
      ↓
主线程
  接收 CadDocument
  WebGL 渲染
```

Worker 默认不会把 parser raw 对象传回主线程，避免 structured clone 失败，也避免大型图纸内存翻倍。只有调试时才建议使用 `keepRaw: true`。

Loader 支持 `AbortSignal`、`workerTimeoutMs`、`workerUrl` 和 `workerFactory`，应用可以取消大文件加载，并适配自定义 bundler/CDN 资源布局。


## Native DWF 渲染模型

DWF、DWFx 和 XPS 使用 native-renderable loader，因为 W2D、W3D/HSF eModel 与 XPS 包内容无法完整塞进轻量 2D `CadDocument` 场景模型。

```text
主线程
  CadViewer.loadFile(file)
  CadLoaderRegistry 识别 DWF/DWFx/XPS
  DwfLoader.mount(input, nativeHost)
      ↓
  dwf-viewer 解析 DWF 包和页面流
  WebGL/WASM renderer 绘制 W2D、W3D/HSF 或 XPS 内容
      ↓
  CadViewer 仍然提供 summary、metadata 和生命周期控制
```

`DwfLoader.load()` 仍可用于程序化读取元数据。`CadViewer` 在发现 loader 实现 `CadNativeRenderableLoader` 时调用 `mount()`。这样可以保持 loader registry 的统一入口，同时让复杂格式拥有独立优化渲染器。

## Loader 合同

每个 loader 实现：

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

普通 loader 输出 `CadDocument`，不直接输出某个 renderer 的绘制命令。native-renderable loader 在格式需要专用 DOM/WebGL viewer 时，可以额外实现 `mount()`。

## 统一场景

`CadDocument` 包含：

- `layers`：归一化图层信息。
- `blocks`：可复用块定义。
- `entities`：顶层实体。
- `pages`：可选页面实体和 native renderer 元数据。
- `warnings`：非致命解析/渲染限制。
- `raw`：原始 parser 输出，便于调试。

## 默认渲染覆盖

WebGL renderer 和 Canvas2D fallback 支持常见预览几何：

- LINE、CIRCLE、ARC、LWPOLYLINE、POLYLINE。
- ELLIPSE、SPLINE 预览多段线。
- TEXT、MTEXT、ATTRIB、DIMENSION 文本兜底。
- INSERT 块展开，支持平移、旋转、缩放。
- SOLID、TRACE、3DFACE。
- HATCH boundary loop 预览。

## 颜色策略

CAD 颜色在渲染时解析，这样可以正确处理 BYLAYER 和主题 foreground。

解析顺序：

1. 显式 CSS/true color 对象；
2. 超出 257 的 true color 整数；
3. 实体 ACI 字段；
4. 图层 ACI / true color；
5. viewer foreground。

这样可以避免把 ACI `color: 1` 错误渲染成 24-bit RGB `#000001`。ACI 7 会跟随 viewer foreground，`contrastMode: 'adaptive'` 可以针对当前画布背景自动提升低对比度颜色。
