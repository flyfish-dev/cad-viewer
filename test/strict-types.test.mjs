import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./types/public-api.mts', import.meta.url));
const host = { getCanonicalFileName: file => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' };
for (const [name, module, moduleResolution] of [
  ['NodeNext', ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
  ['Bundler', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
]) {
  test(`published declarations preserve the public CAD API under strict ${name}`, () => {
    const program = ts.createProgram([fixture], {
      target: ts.ScriptTarget.ES2022, module, moduleResolution,
      strict: true, skipLibCheck: false, noEmit: true,
      noUncheckedSideEffectImports: true, types: [],
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
  });
}
