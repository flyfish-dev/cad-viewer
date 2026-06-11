const fs = require('node:fs');
const path = require('node:path');

for (const dir of ['dist', 'dist-demo']) {
  fs.rmSync(path.resolve(__dirname, '..', dir), { recursive: true, force: true });
}
