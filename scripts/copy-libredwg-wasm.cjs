const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const targetDir = path.join(projectRoot, 'public', 'wasm');
const candidates = [
  path.join(projectRoot, 'node_modules', '@mlightcad', 'libredwg-web', 'wasm'),
  path.join(projectRoot, 'node_modules', '@mlightcad', 'libredwg-web', 'dist', 'wasm'),
  path.join(projectRoot, 'node_modules', '@mlightcad', 'libredwg-web', 'lib', 'wasm'),
  path.join(projectRoot, 'node_modules', '@mlightcad', 'libredwg-web', 'dist')
];

fs.mkdirSync(targetDir, { recursive: true });
let copied = 0;
for (const sourceDir of candidates) {
  if (!fs.existsSync(sourceDir)) continue;
  for (const entry of fs.readdirSync(sourceDir)) {
    if (!/^(libredwg-web\.(wasm|js)|.*\.data|.*worker\.js)$/i.test(entry)) continue;
    fs.copyFileSync(path.join(sourceDir, entry), path.join(targetDir, entry));
    copied++;
  }
  if (copied > 0) break;
}

const wasmFile = path.join(targetDir, 'libredwg-web.wasm');
if (!fs.existsSync(wasmFile)) {
  console.error('[cad-viewer] libredwg-web.wasm was not found. Run npm install first and verify @mlightcad/libredwg-web is installed.');
  process.exitCode = 1;
  return;
}

const header = fs.readFileSync(wasmFile).subarray(0, 4);
const valid = header.length === 4 && header[0] === 0x00 && header[1] === 0x61 && header[2] === 0x73 && header[3] === 0x6d;
if (!valid) {
  console.error(`[cad-viewer] ${wasmFile} is not a valid WebAssembly binary.`);
  process.exitCode = 1;
  return;
}

console.log(`[cad-viewer] Copied ${copied} LibreDWG asset(s) to public/wasm. WASM size: ${fs.statSync(wasmFile).size} bytes.`);
