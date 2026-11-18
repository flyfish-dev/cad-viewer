import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { normalizeCadEntity, normalizeDwgDatabase } from '../dist/cad-viewer.es.js';

// Exercise the internal pure layout module without making test-only public exports.
const source = readFileSync(new URL('../src/core/text.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { decodeCadUnicodeEscapes, parseCadText, layoutCadText, paintCadText, cadTextLayoutBounds } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
const transformSource = readFileSync(new URL('../src/core/transform.ts', import.meta.url), 'utf8');
const transformCompiled = ts.transpileModule(transformSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { transformEntity } = await import(`data:text/javascript;base64,${Buffer.from(transformCompiled.outputText).toString('base64')}`);

function metricsContext() {
  return {
    font: '100px sans-serif',
    measureText(text) {
      const height = Number(this.font.match(/([\d.]+)px/)[1]);
      return { width: Array.from(text).reduce((sum, char) => sum + (char === ' ' ? 0.5 : 1), 0) * height };
    }
  };
}
const contents = (layout) => layout.lines.map((line) => line.fragments.map((fragment) => fragment.text).join(''));

test('CAD Unicode escapes decode exactly four hex digits and preserve following A–F text', () => {
  assert.equal(parseCadText(String.raw`\U+4E2DA1 \U+6587F2 \U+D83D\U+DE00`).text, '中A1 文F2 😀');
  assert.equal(decodeCadUnicodeEscapes(String.raw`\U+4E2DA1 \\U+6587`), String.raw`中A1 \\U+6587`);
});

test('one-pass controls preserve literal backslashes/braces and Unicode-produced control-looking text', () => {
  assert.equal(parseCadText(String.raw`\\U+4E2D \{value\} \\P \U+005CU+0041`).text, String.raw`\U+4E2D {value} \P \U+0041`);
  assert.equal(parseCadText(String.raw`C:\Users\guest {literal}`, false).text, String.raw`C:\Users\guest {literal}`);
});

test('MTEXT removes only known formatting and keeps Cyrillic, semicolons, fractions and blank paragraphs', () => {
  const raw = String.raw`{\fTimes New Roman|b0|i0|c134|p18;\H1.25x;\W0.7;\C256;\U+041F\U+0440\U+043E\U+0435\U+043A\U+0442; A1}\P\P\S1#2; %%d %%p %%c`;
  assert.equal(parseCadText(raw).text, 'Проект; A1\n\n1/2 ° ± ∅');
  assert.equal(parseCadText(String.raw`keep\Z999; and \Hmissing\Pnext`).text, String.raw`keep\Z999; and \Hmissing` + '\nnext');
  assert.equal(parseCadText(String.raw`keep\Hword; \Wbad;`).text, String.raw`keep\Hword; \Wbad;`);
  assert.equal(parseCadText('{'.repeat(100000) + 'safe' + '}'.repeat(100000)).text, 'safe');
});

test('nested text height and width controls reset at group boundaries', () => {
  const data = parseCadText(String.raw`A{\H2x;\W0.5;B{\H0.5x;C}D}E`, true, 3.5);
  const runs = data.paragraphs[0].runs;
  assert.deepEqual(runs.map((run) => [run.text, run.style.height, run.style.width]), [
    ['A', 1, 1], ['B', 2, 0.5], ['C', 1, 0.5], ['D', 2, 0.5], ['E', 1, 1]
  ]);
});

test('inline MTEXT width overrides the STYLE width instead of multiplying it twice', () => {
  const data = parseCadText(String.raw`A{\W0.7;B}C{\W0.5x;D}`, true, 1, undefined, 0.8);
  assert.deepEqual(data.paragraphs[0].runs.map((run) => [run.text, run.style.width]), [
    ['A', 0.8], ['B', 0.7], ['C', 0.8], ['D', 0.4]
  ]);
  const entity = { type: 'MTEXT', text: String.raw`\W0.7;ABCDE`, width: 2, textHeight: 1, textStyleWidthFactor: 0.8 };
  const original = layoutCadText(metricsContext(), entity);
  assert.deepEqual(contents(original), ['AB', 'CD', 'E']);
  const scaled = transformEntity(entity, { a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 });
  assert.deepEqual(contents(layoutCadText(metricsContext(), scaled)), contents(original));
});

test('worker-safe normalization retains MTEXT reference width, attachment and line spacing', () => {
  const raw = { type: 'MTEXT', text: 'A\\PB', rectWidth: 14, attachmentPoint: 9, lineSpacing: 1.5, lineSpacingStyle: 2, textHeight: 3.5, direction: { x: 0, y: 1 } };
  const direct = normalizeCadEntity(raw, undefined, { includeUnknownProperties: false });
  assert.equal(direct.width, 14);
  assert.equal(direct.attachmentPoint, 9);
  assert.equal(direct.lineSpacingFactor, 1.5);
  assert.equal(direct.lineSpacingStyle, 2);
  assert.equal(direct.rotation, Math.PI / 2);
  const document = normalizeDwgDatabase({ entities: [raw] });
  assert.equal(document.entities[0].width, 14);
  assert.equal(document.entities[0].lineSpacingFactor, 1.5);
});

test('MTEXT wraps Chinese at the authored width, keeps explicit paragraphs and all characters', () => {
  const entity = { type: 'MTEXT', text: '说明：\\P施工材料必须验收合格', textHeight: 2, width: 6 };
  const layout = layoutCadText(metricsContext(), entity);
  assert.deepEqual(contents(layout), ['说明：', '施工材', '料必须', '验收合', '格']);
  assert.ok(layout.lines.every((line) => line.width <= 3));
  assert.equal(contents(layout).join(''), '说明：施工材料必须验收合格');
  assert.equal(layout.lines[1].y, 5 / 3);
  const indented = layoutCadText(metricsContext(), { type: 'MTEXT', text: 'A\\P  indented', textHeight: 1, width: 20 });
  assert.deepEqual(contents(indented), ['A', '  indented']);
});

test('word wrapping respects width factors, long identifiers and escaped raw text', () => {
  const layout = layoutCadText(metricsContext(), { type: 'MTEXT', textHeight: 2, width: 8, xScale: 0.5, text: 'one two three' });
  assert.deepEqual(contents(layout), ['one two', 'three']);
  const narrow = layoutCadText(metricsContext(), { type: 'MTEXT', textHeight: 1, width: 2, text: 'ABCDE' });
  assert.deepEqual(contents(narrow), ['AB', 'CD', 'E']);
  const literal = layoutCadText(metricsContext(), { type: 'TEXT', text: String.raw`\U+0041`, rawText: String.raw`\U+005CU+0041` });
  assert.deepEqual(contents(literal), [String.raw`\U+0041`]);
  const styled = layoutCadText(metricsContext(), { type: 'MTEXT', textHeight: 1, width: 2, text: String.raw`\W0.5;ABCD` });
  assert.deepEqual(contents(styled), ['ABCD']);
  const nonbreaking = layoutCadText(metricsContext(), { type: 'MTEXT', textHeight: 1, width: 2, text: String.raw`A\~B` });
  assert.deepEqual(contents(nonbreaking), ['A\u00a0B']);
});

test('attachment points offset the entire text box; exact spacing remains fixed for large inline text', () => {
  for (let attachmentPoint = 1; attachmentPoint <= 9; attachmentPoint++) {
    const layout = layoutCadText(metricsContext(), { type: 'MTEXT', textHeight: 1, width: 4, text: 'A\\PB', attachmentPoint });
    assert.equal(layout.offsetX, -((attachmentPoint - 1) % 3) * 2);
    assert.equal(layout.offsetY, -Math.floor((attachmentPoint - 1) / 3) * layout.height / 2);
  }
  const entity = { type: 'MTEXT', textHeight: 1, text: String.raw`{\H3x;A}\PB`, lineSpacingFactor: 1.5 };
  assert.equal(layoutCadText(metricsContext(), { ...entity, lineSpacingStyle: 2 }).lines[1].y, 2.5);
  assert.equal(layoutCadText(metricsContext(), { ...entity, lineSpacingStyle: 1 }).lines[1].y, 7.5);
});

test('painting preserves model-sized line positions at every zoom', () => {
  const trace = [];
  const ctx = { ...metricsContext(), save() {}, restore() {}, translate(x, y) { trace.push([x, y]); }, scale() {}, fillText() {} };
  const entity = { type: 'MTEXT', text: 'ABCD', width: 2, textHeight: 1, attachmentPoint: 1 };
  const layout = paintCadText(ctx, entity, 10);
  assert.deepEqual(trace, [[0, 0], [10, 0], [0, 50 / 3], [10, 50 / 3]]);
  trace.length = 0;
  paintCadText(ctx, entity, 20, layout);
  assert.deepEqual(trace, [[0, 0], [20, 0], [0, 100 / 3], [20, 100 / 3]]);
});

test('nonuniform block scaling preserves authored wrap points even without an explicit glyph width factor', () => {
  const entity = { type: 'MTEXT', text: 'ABCDEF', width: 4, textHeight: 1 };
  const scaled = transformEntity(entity, { a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 });
  assert.equal(scaled.width, 8);
  assert.equal(scaled.xScale, 2);
  assert.deepEqual(contents(layoutCadText(metricsContext(), scaled)), contents(layoutCadText(metricsContext(), entity)));
});

test('visibility bounds cover enlarged, attached, rotated MTEXT, not only its insertion point', () => {
  const entity = { type: 'MTEXT', text: String.raw`\H100x;\W2;A`, width: 400, textHeight: 1, attachmentPoint: 9, rotation: Math.PI / 2 };
  const layout = layoutCadText(metricsContext(), entity);
  const bounds = cadTextLayoutBounds(entity, layout, { x: 0, y: 0 });
  assert.ok(bounds.minY <= -400 && bounds.maxY >= -200, JSON.stringify(bounds));
  assert.ok(bounds.minX <= -100 && bounds.maxX >= 0, JSON.stringify(bounds));
});
