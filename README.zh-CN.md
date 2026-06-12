# @flyfish-dev/cad-viewer

一个专业、轻量、可扩展的**纯前端 CAD Viewer**。

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-b31b1b.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@flyfish-dev/cad-viewer.svg)](https://www.npmjs.com/package/@flyfish-dev/cad-viewer)

**在线 Demo：** [cad-viewer-iys.pages.dev](https://cad-viewer-iys.pages.dev)  
**源码仓库：** [github.com/flyfish-dev/cad-viewer](https://github.com/flyfish-dev/cad-viewer)

本仓库提供面向浏览器的 loader 架构，支持 **DWG**、**DXF**、**DWF**、**DWFx** 和 **XPS**。DWG/DXF 会归一化为统一 `CadDocument` 并通过 WebGL retained-mode 渲染，文字/图片使用轻量 Canvas overlay；DWF/DWFx/XPS 交给原生 `dwf-viewer` 渲染通道处理 WebGL 加速的 W2D 与 XPS/DWFx 矢量、W3D/HSF eModel、XPS 嵌入字体和可选 WASM fallback。文件在浏览器本地读取，组件不会把图纸上传到服务端。

> DWG 使用 `@mlightcad/libredwg-web` / LibreDWG WebAssembly，并默认运行在 Worker 中。DXF 使用 JavaScript 解析器并带内置 fallback。DWF、DWFx、XPS 由 `dwf-viewer` 0.6.x 驱动，覆盖 DWF 6+ ZIP 包、WHIP/W2D 2D 图纸、W3D/HSF 3D eModel、DWFx/OPC/XPS 页面、自适应 CAD 线宽和可选 raster WASM fallback。

## 0.6.1 变更

- 原生 DWF 通道升级到 `dwf-viewer` 0.6.1。
- 同步最新 renderer 行为：WebGL 加速 XPS/DWFx 与 W2D 2D 矢量渲染、W3D/HSF 3D 渲染、XPS 嵌入字体加载和可选 WASM raster fallback。
- 新增 `dwfLineWeightMode`、`dwfMinStrokeCssPx`、`dwfMaxOverviewStrokeCssPx`、`dwfMinTextCssPx`、`dwfMinFilledAreaCssPx`，用于调节 DWF/XPS 总览渲染效果。
- 更新 README、格式说明、架构说明和 package metadata，统一最新版 DWF 支持口径。

## 0.6.0 变更

- 使用已发布的 `dwf-viewer` 原生渲染器替换旧 DWFx/XPS 子集解析器。
- DWF/DWFx/XPS 不再强行转成普通 DWG/DXF 的 2D `CadDocument` 渲染链路，而是通过专用 native viewer 挂载。
- 新增 DWF 6+ ZIP 包、WHIP/W2D 2D 图纸、W3D/HSF 3D eModel、DWFx/OPC/XPS 页面，以及 dwf-viewer WebGL/WASM 渲染后端集成。
- 新增 `CadNativeRenderableLoader`，允许某些格式挂载自己的 DOM/WebGL 渲染器。
- 新增 `dwfWasmUrl`、`dwfPreferWebgl`、`dwfPreferWasm`、`dwfMaxCanvasPixels`、`dwfMaxGpuCacheBytes` 等生产配置。
- 运行时资源脚本现在会同时复制和校验 `libredwg-web.wasm` 与 `dwfv-render.wasm`。
- 删除旧 classic-DWF warning 逻辑，并移除本包对 `fflate` 的依赖。
- 包许可证更新为 AGPL-3.0-only，以匹配集成后的 DWF 渲染器。

## 0.5.3 变更

- 修复 DWG 图层索引色显示。LibreDWG 输出的索引色图层会优先按 ACI 解析，不再被 converter 的 `0xffffff` 占位值渲染成单色白图。
- 保留 DWG true-color 数值，即使 RGB 整数落在 ACI 范围内，例如 `0x0000ff`。
- 展开 INSERT/block 时增加 BYBLOCK 颜色继承。

## 0.5.2 变更

- 修复 `@mlightcad/libredwg-web` 入口导致的 Vite 超长 `data:application/wasm;base64,...` warning。
- DWG worker 构建改为使用 LibreDWG 的轻量 ESM wrapper，并在运行时从 `wasmPath` 加载 `/wasm/libredwg-web.js` 和 `/wasm/libredwg-web.wasm`，避免重复打包内联 wasm。
- `build:lib` 会生成 `dist/index.js` 兼容入口，兼容仍然请求 `/dist/index.js` 的旧集成方式。
- Vite dev 模式下新增 `/dist/index.js` 兼容路由，旧 demo 页面会被转到 `/demo/main.ts`，不再直接 404。
- `npm run preview` 会先构建 demo，干净仓库也可以直接预览。

## 0.5 变更

- 默认渲染后端升级为 **WebGL retained renderer**，首帧把 CAD 图元扁平化并上传为 GPU buffer，缩放/平移只更新 view uniform。
- 新增空间索引和 viewport culling：线段、三角面、点会按图纸范围分桶，放大查看局部区域时只提交可见 batch。
- 新增大图纸内存策略：坐标以图纸中心为 origin 存入 `Float32Array`，颜色存入 `Uint8Array`，上传后释放 CPU 临时数组，避免 Canvas2D 每帧重建路径。
- 文字、图片走独立 overlay，并带屏幕尺寸阈值和最大可见 label 限制，避免高密度图纸在缩放时被文字拖慢。
- `CadViewer` 新增 `renderer: 'auto' | 'webgl' | 'canvas2d'`；`auto` 优先 WebGL，不可用时回退 Canvas2D。
- Demo 新增 Renderer、visible primitives、GPU memory 指标，便于排查大图纸性能。

## 0.4 变更

- DWG 解析默认放到**独立 Web Worker** 中执行，LibreDWG WASM 初始化和二进制解析不会阻塞 UI、缩放和平移。
- Worker 会常驻并复用 LibreDWG WASM 实例，连续打开多个 DWG 时不重复初始化。
- 增加 `AbortSignal` 取消加载、worker timeout、加载进度事件，以及显式 worker 资源配置。
- 默认不再把 DWG raw parser 对象传回主线程，降低内存占用并避免 structured clone 失败；确实需要时可显式设置 `keepRaw: true`。
- Demo 增加加载遮罩、进度条、取消按钮和 loader mode 指示。
- `viewer.destroy()` 会清理 Canvas 监听器并终止持有的 DWG worker，适合 SPA 路由切换。
- 导出 `supportsDwgWorker` 和 `DwgWorkerClient`，方便高级集成。

## 功能特性

- **纯前端组件**：`new CadViewer({ container })` 或 `new CadViewer({ canvas })`。
- **正确的 loader 架构**：DWG / DXF / DWF 独立 loader，可替换、可扩展；native-renderable loader 可以挂载自己的优化渲染器。
- **DWG 预览**：通过 LibreDWG WebAssembly 在浏览器本地解析，默认在 Web Worker 中执行。
- **DXF 预览**：JavaScript 解析，支持常见 ASCII DXF `ENTITIES`，并带 fallback parser。
- **DWF/DWFx/XPS 预览**：由 `dwf-viewer` 支持 DWF ZIP 包、WebGL 加速 W2D 与 XPS/DWFx 2D 矢量、W3D/HSF eModel、XPS 嵌入字体、自适应 CAD 线宽和 raster fallback。
- **CAD 颜色处理**：支持 ACI、BYLAYER、BYBLOCK 继承、DWG 图层颜色、true color、填充色、透明度和自适应对比度。
- **WebGL 高性能交互**：GPU retained buffers、空间分桶、视口裁剪、缩放、平移、适配窗口、世界坐标、缩放百分比。
- **专业 Demo**：拖拽打开、紧凑工具栏、状态条、解析/渲染耗时、实体类型统计、warnings 展示。
- **发布友好**：同时提供 npm library build 和 Cloudflare Pages demo build。

## 安装

```bash
npm install @flyfish-dev/cad-viewer
```

本仓库本地开发：

```bash
npm install
npm run dev
```

DWG 和 DWF 渲染链路需要将运行时 WASM 文件放到公开目录。Demo 使用以下命令复制并校验到 `public/wasm`：

```bash
npm run copy:wasm
npm run check:wasm
```

Demo 会先把 `wasmPath` 解析为绝对 URL，再发送给 DWG worker，并复用同一目录查找 `dwfv-render.wasm`。你自己的应用也建议使用绝对路径或绝对 URL，例如 `/wasm` 或 `new URL('wasm/', document.baseURI).href`。不要直接把未解析的 `./wasm` 传入 worker，否则它可能会相对于 worker chunk 请求资源。

发布 npm 包时，`build:lib` 会把这些文件复制到 `dist/wasm` 并作为 package subpath 暴露出来。应用侧仍需要把 `.wasm` 放到可公开访问的 URL，并把该目录传给 `wasmPath`，或者显式传入 `dwfWasmUrl`。


## Demo 启动说明

源码 demo 必须通过 Vite 启动：

```bash
npm install
npm run dev
```

生产预览使用：

```bash
npm run preview
```

不要直接用普通静态服务器托管源码目录并期望 TypeScript 入口能运行。如果旧页面仍请求 `/dist/index.js`，请先执行 `npm run build:lib` 生成兼容入口，或者直接使用上面的 Vite dev server。

## 基础用法

```ts
import { CadViewer } from '@flyfish-dev/cad-viewer';
import '@flyfish-dev/cad-viewer/style.css';

const viewer = new CadViewer({
  container: document.querySelector('#viewer')!,
  renderer: 'auto',       // WebGL first, Canvas2D fallback
  wasmPath: new URL('wasm/', document.baseURI).href,
  dwfWasmUrl: new URL('wasm/dwfv-render.wasm', document.baseURI).href,
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


## WebGL 渲染与性能策略

默认 `renderer: 'auto'` 会优先创建 `CadWebGLRenderer`。它不是每次缩放都用 Canvas2D 重新遍历实体，而是在 `setDocument()` 时构建一次 retained scene：

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

可调参数：

```ts
new CadViewer({
  container,
  renderer: 'auto', // 'webgl' 强制 WebGL；'canvas2d' 强制兼容模式
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

对超大图纸，优先调小 `maxCurveSegments`、增大 `spatialIndexCellCount`，并限制 `maxVisibleTextLabels`。

## Worker 化 DWG 解析

`DwgLoader` 在浏览器里默认使用 module Web Worker。Worker 内部导入 `@mlightcad/libredwg-web`，初始化 LibreDWG WASM，缓存该 WASM 实例，解码 DWG 字节，并把结果归一化为可 structured-clone 的 `CadDocument` 后发送回 UI 线程。Canvas 渲染仍然留在主线程。

```ts
const controller = new AbortController();

const viewer = new CadViewer({
  container,
  wasmPath: new URL('wasm/', document.baseURI).href,
  dwfWasmUrl: new URL('wasm/dwfv-render.wasm', document.baseURI).href,
  useWorker: true,
  workerTimeoutMs: 120_000,
  onLoadProgress(progress) {
    console.log(progress.phase, progress.message, progress.percent);
  }
});

await viewer.preloadDwg(); // 可选：首个文件打开前预热 worker
await viewer.loadFile(file, { signal: controller.signal });

// 取消大型 DWG 加载
controller.abort();
```

如果你的构建系统或 CDN 对 worker 资源路径有特殊要求，可以显式传入 worker 地址：

```ts
new CadViewer({
  container,
  wasmPath: new URL('wasm/', document.baseURI).href,
  dwfWasmUrl: new URL('wasm/dwfv-render.wasm', document.baseURI).href,
  workerUrl: new URL('/assets/dwg-worker.js', window.location.origin)
});
```

默认包是 worker-first 设计。非浏览器运行时建议注册自定义 DWG loader，而不是关闭 worker。

## 组件 API

```ts
const viewer = new CadViewer({
  container,             // 容器元素，组件会自动创建 canvas
  canvas,                // 也可以传入已有 canvas
  renderer: 'auto',      // 'auto' | 'webgl' | 'canvas2d'
  wasmPath: '/wasm',     // LibreDWG WebAssembly 资源路径。Worker 场景建议使用绝对路径/URL
  dwfWasmUrl: '/wasm/dwfv-render.wasm',
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
  useWorker: true,                 // DWG 默认开启
  workerTimeoutMs: 0,              // 0 表示不限制
  dwfPreferWebgl: true,
  dwfPreferWasm: true,
  dwfMaxCanvasPixels: 16_777_216,
  dwfLineWeightMode: 'adaptive',  // 'adaptive' | 'physical' | 'hairline'
  dwfMinStrokeCssPx: 0.42,
  dwfMinTextCssPx: 1.05,
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
await viewer.preloadDwg();       // 可选 DWG worker/WASM 预热
viewer.setCanvasOptions({ background: '#f7f8fb', foreground: '#111827' });
viewer.clear();
viewer.destroy();
```

## Loader 架构

```text
File / ArrayBuffer
  ↓
CadLoaderRegistry
  ↓
DwgLoader | DxfLoader | DwfLoader | 自定义 loader
  ↓
DWG/DXF：CadDocument → CadWebGLRenderer | CadCanvasRenderer fallback
DWF/DWFx/XPS：DwfLoader.mount() → dwf-viewer native WebGL 矢量 / 3D / WASM fallback
```

所有 loader 都输出统一的 `CadDocument`：

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

注册自定义 loader：

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

## 格式支持说明

| 格式 | Loader | 支持范围 |
|---|---|---|
| DWG | `DwgLoader` | 使用 LibreDWG WebAssembly。渲染完整度取决于 LibreDWG converter 暴露出的实体。 |
| DXF | `DxfLoader` | 使用 `dxf-parser` + 内置 fallback。支持基础实体、block/insert、颜色/图层、多段线、文字、hatch boundary、spline 预览。 |
| DWF | `DwfLoader` + `dwf-viewer` | DWF 6+ ZIP 包、WHIP/W2D 2D 图纸、W3D/HSF 3D eModel、模型树元数据、WebGL 渲染和可选 WASM fallback。 |
| DWFx / XPS | `DwfLoader` + `dwf-viewer` | DWFx/OPC/XPS 页面，包含 WebGL 加速 vector path、嵌入字体、文本、图片、包内资源和自适应总览线宽，通过原生 DWF 渲染器展示。 |

## 颜色处理

颜色解析遵循 CAD 语义，而不是把所有数字都当成 RGB：

1. 显式 CSS color 或 true color 对象；
2. 显式 DWG true-color 整数，包括 `0x0000ff` 这类落在 ACI 数值范围内的低 RGB 值；
3. 实体 ACI：`colorIndex`、`colorNumber`、`color` 的 `1..255`；
4. 展开 INSERT/block 时处理 BYBLOCK：`0` 继承插入引用颜色；
5. BYLAYER：`256` 或未设置时查图层颜色；
6. viewer foreground 兜底。

当 converter 同时暴露有效 ACI 和占位 RGB 值时，图层颜色优先使用 ACI。ACI `7` 会根据画布前景色显示：深色画布上为浅色，浅色画布上为深色。开启 `contrastMode: 'adaptive'` 后，和当前画布背景过近的颜色会被轻量调整，保证可读性。需要严格保留绘图颜色时，可以使用 `contrastMode: 'preserve'`。

如果某个 converter 输出的是 BGR true-color 整数：

```ts
new CadViewer({ canvasOptions: { trueColorByteOrder: 'bgr' } });
```

## 开发命令

```bash
npm install
npm run dev          # 运行 demo
npm run typecheck    # TypeScript 检查
npm run build        # 构建 library + demo
npm run preview      # 预览构建后的 demo
```

## npm 发布命令

1. 构建并检查包内容：

```bash
npm run build:lib
npm run pack:dry
```

2. 发布：

```bash
npm login
npm publish --access public --auth-type=web
```

仓库内也提供：

```bash
npm run release:npm
```

## Cloudflare Pages 发布命令

使用 Wrangler Direct Upload：

```bash
npm install
npm run build:demo
npx wrangler pages deploy dist-demo --project-name cad-viewer
```

或直接使用：

```bash
npm run deploy:pages
```

GitHub Actions 自动发布需要配置仓库 secrets：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

工作流文件在 `.github/workflows/pages.yml`。

## 目录结构

```text
src/
  core/          格式检测、颜色、几何、变换、统一类型
  loaders/       DwgLoader、DxfLoader、DwfLoader、CadLoaderRegistry
  viewer/        CadViewer 组件和 Canvas renderer
demo/            专业 Vite demo UI
docs/            中英文架构/格式文档
scripts/         clean、运行时 WASM 复制与校验脚本
public/wasm/     demo 的 WASM 输出目录
```

## 许可证

AGPL-3.0-only。默认 DWG loader 集成 `@mlightcad/libredwg-web` / LibreDWG，DWF 渲染器集成 `dwf-viewer`。二开、分发、嵌入或作为应用组成部分使用时，请保留出处和许可证说明。闭源商用产品需要审阅所有依赖许可证，并在授权模型需要时替换对应 loader。
