const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const publicWasm = path.join(projectRoot, 'public', 'wasm');
const dist = path.join(projectRoot, 'dist');
const distWasm = path.join(dist, 'wasm');
const required = ['libredwg-web.wasm', 'dwfv-render.wasm'].map((entry) => path.join(publicWasm, entry));
const requiredDist = ['dwg-worker.js'].map((entry) => path.join(distWasm, entry));

for (const file of required) {
  if (!fs.existsSync(file)) {
    console.error(`[cad-viewer] Missing ${file}. Run npm run copy:wasm before copying dist assets.`);
    process.exit(1);
  }
}

for (const file of requiredDist) {
  if (!fs.existsSync(file)) {
    console.error(`[cad-viewer] Missing ${file}. Run npm run build:worker before copying dist assets.`);
    process.exit(1);
  }
}

fs.mkdirSync(distWasm, { recursive: true });
for (const entry of fs.readdirSync(publicWasm)) {
  if (/^dwg-worker.*\.js(\.map)?$/i.test(entry)) continue;
  if (!/\.(wasm|js|data|worker\.js)$/i.test(entry)) continue;
  const target = path.join(distWasm, entry);
  fs.copyFileSync(path.join(publicWasm, entry), target);
  fs.chmodSync(target, 0o644);
}

// Compatibility entry for consumers or static examples that request /dist/index.js.
// The canonical ESM bundle remains cad-viewer.es.js.
fs.writeFileSync(
  path.join(dist, 'index.js'),
  "export * from './cad-viewer.es.js';\n",
  'utf8'
);
fs.writeFileSync(
  path.join(dist, 'index.d.ts'),
  "export * from './types/index';\n",
  'utf8'
);

console.log('[cad-viewer] Copied LibreDWG and dwf-viewer runtime assets to dist/wasm, kept the freshly built DWG worker, and created dist/index.js compatibility entry.');
