const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const publicWasm = path.join(projectRoot, 'public', 'wasm');
const dist = path.join(projectRoot, 'dist');
const distWasm = path.join(dist, 'wasm');
const required = path.join(publicWasm, 'libredwg-web.wasm');

if (!fs.existsSync(required)) {
  console.error('[cad-viewer] Missing public/wasm/libredwg-web.wasm. Run npm run copy:wasm before copying dist assets.');
  process.exit(1);
}

fs.mkdirSync(distWasm, { recursive: true });
for (const entry of fs.readdirSync(publicWasm)) {
  if (!/\.(wasm|js|data|worker\.js)$/i.test(entry)) continue;
  fs.copyFileSync(path.join(publicWasm, entry), path.join(distWasm, entry));
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

console.log('[cad-viewer] Copied LibreDWG runtime assets to dist/wasm and created dist/index.js compatibility entry.');
