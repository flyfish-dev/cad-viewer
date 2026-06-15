const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const sourceDir = path.join(projectRoot, 'dist', 'wasm');
const targetDir = path.join(projectRoot, 'public', 'wasm');
const requiredWorker = path.join(sourceDir, 'dwg-worker.js');

if (!fs.existsSync(requiredWorker)) {
  console.error('[cad-viewer] Missing dist/wasm/dwg-worker.js. Run npm run build:worker before npm run copy:worker.');
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });

let copied = 0;
for (const entry of fs.readdirSync(sourceDir)) {
  if (!/^dwg-worker.*\.js(\.map)?$/i.test(entry)) continue;
  const source = path.join(sourceDir, entry);
  fs.copyFileSync(source, path.join(targetDir, entry));
  copied++;
}

console.log(`[cad-viewer] Copied ${copied} DWG worker runtime asset(s) to public/wasm.`);
