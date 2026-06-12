const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const targetDir = path.join(projectRoot, 'public', 'wasm');
fs.mkdirSync(targetDir, { recursive: true });

const libredwgCandidates = [
  path.join(projectRoot, 'node_modules', '@mlightcad', 'libredwg-web', 'wasm'),
  path.join(projectRoot, 'node_modules', '@mlightcad', 'libredwg-web', 'dist', 'wasm'),
  path.join(projectRoot, 'node_modules', '@mlightcad', 'libredwg-web', 'lib', 'wasm'),
  path.join(projectRoot, 'node_modules', '@mlightcad', 'libredwg-web', 'dist')
];

let libredwgCopied = 0;
for (const sourceDir of libredwgCandidates) {
  if (!fs.existsSync(sourceDir)) continue;
  for (const entry of fs.readdirSync(sourceDir)) {
    if (!/^(libredwg-web\.(wasm|js)|.*\.data|.*worker\.js)$/i.test(entry)) continue;
    fs.copyFileSync(path.join(sourceDir, entry), path.join(targetDir, entry));
    libredwgCopied++;
  }
  if (libredwgCopied > 0) break;
}

const dwfvSource = path.join(projectRoot, 'node_modules', 'dwf-viewer', 'public', 'dwfv-render.wasm');
const dwfvTarget = path.join(targetDir, 'dwfv-render.wasm');
if (fs.existsSync(dwfvSource)) {
  fs.copyFileSync(dwfvSource, dwfvTarget);
} else {
  console.error('[cad-viewer] dwf-viewer/public/dwfv-render.wasm was not found. Run npm install and verify dwf-viewer is installed.');
  process.exit(1);
}

const required = [
  path.join(targetDir, 'libredwg-web.wasm'),
  dwfvTarget
];
for (const wasmFile of required) validateWasm(wasmFile);

console.log(`[cad-viewer] Copied ${libredwgCopied} LibreDWG asset(s) and dwf-viewer raster WASM to public/wasm.`);
for (const wasmFile of required) {
  console.log(`[cad-viewer] Verified ${path.basename(wasmFile)}: ${fs.statSync(wasmFile).size} bytes.`);
}

function validateWasm(file) {
  if (!fs.existsSync(file)) {
    console.error(`[cad-viewer] Missing ${file}.`);
    process.exit(1);
  }
  const header = fs.readFileSync(file).subarray(0, 4);
  const valid = header.length === 4 && header[0] === 0x00 && header[1] === 0x61 && header[2] === 0x73 && header[3] === 0x6d;
  if (!valid) {
    console.error(`[cad-viewer] ${file} is not a valid WebAssembly binary.`);
    process.exit(1);
  }
}
