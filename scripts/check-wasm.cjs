const fs = require('node:fs');
const path = require('node:path');

const wasmFiles = [
  path.resolve(__dirname, '..', 'public', 'wasm', 'libredwg-web.wasm'),
  path.resolve(__dirname, '..', 'public', 'wasm', 'dwfv-render.wasm')
];
for (const wasmFile of wasmFiles) {
  if (!fs.existsSync(wasmFile)) {
    console.error(`[cad-viewer] Missing ${wasmFile}. Run npm run copy:wasm.`);
    process.exit(1);
  }
  const header = fs.readFileSync(wasmFile).subarray(0, 4);
  if (!(header[0] === 0x00 && header[1] === 0x61 && header[2] === 0x73 && header[3] === 0x6d)) {
    console.error(`[cad-viewer] ${wasmFile} exists but is not a valid WebAssembly file.`);
    process.exit(1);
  }
  console.log(`[cad-viewer] WASM asset verified: ${wasmFile}`);
}
