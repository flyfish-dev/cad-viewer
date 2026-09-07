/** Copies rendered layers synchronously, before a WebGL drawing buffer clears. */
export function captureCanvasLayers(layers: readonly HTMLCanvasElement[]): HTMLCanvasElement {
  const base = layers[0];
  if (!base || !base.width || !base.height) throw new Error('CAD canvas is not ready for capture.');
  const snapshot = base.ownerDocument.createElement('canvas');
  snapshot.width = base.width;
  snapshot.height = base.height;
  const context = snapshot.getContext('2d');
  if (!context) throw new Error('Canvas 2D is required for CAD capture.');
  for (const canvas of layers) {
    context.drawImage(canvas, 0, 0, snapshot.width, snapshot.height);
  }
  return snapshot;
}
