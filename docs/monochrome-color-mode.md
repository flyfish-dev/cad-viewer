# Monochrome CAD color mode

`CadViewer` can render authored CAD colors or apply one fixed plot color without rewriting parser-owned data.

```ts
import { CadViewer } from '@flyfish-dev/cad-viewer';

const viewer = new CadViewer({
  container,
  colorMode: 'monochrome',
  monochromeColor: '#000000',
});

await viewer.loadFile(file);

// Switch at runtime while retaining the active pan/zoom view.
viewer.setColorMode('source');
viewer.setColorMode('monochrome', '#000000');
```

The policy is applied by the shared color resolver, so normalized DWG/DXF output is consistent across Canvas2D, retained WebGL geometry, text overlays, fills, layer colors and ByBlock inheritance. Source entity colors, line types, line weights, visibility, geometry and alpha values are preserved.

Native DWF/DWFx/XPS rendering forwards the same fixed color to `dwf-viewer` when the installed native renderer exposes `setMonochromeColor()`.

For lower-level rendering, use `createCadRenderDocument()` to attach a render-only policy to a shallow document view and pass that view to a renderer. `readCadColorPolicy()` inspects the active policy.
