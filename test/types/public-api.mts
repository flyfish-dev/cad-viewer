import {
  CadViewer,
  createCadViewer,
  extractCadBom,
  type CadDocument,
  type CadViewerOptions,
  type CanvasViewerOptions,
} from '@flyfish-dev/cad-viewer';
import type * as Compatibility from '../../dist/index.js';

declare const host: HTMLElement;
declare const document: CadDocument;
const options: CadViewerOptions = { container: host, renderer: 'canvas2d' };
const viewer: CadViewer = createCadViewer(options);
const constructor: typeof Compatibility.CadViewer = CadViewer;
const canvas: CanvasViewerOptions = {};
extractCadBom(document);
void [viewer, constructor, canvas];
// @ts-expect-error Renderer backends remain a closed public union.
const invalid: CadViewerOptions = { renderer: 'unknown-backend' };
void invalid;
