import assert from 'node:assert/strict';
import test from 'node:test';
import { CadCanvasRenderer, CadWebGLRenderer, createCadDocument, normalizeCadEntity, normalizeDwgDatabase } from '../dist/cad-viewer.es.js';

const point = (x, y) => ({ x, y });
const square = (x, y, size) => ({
  boundaryPathTypeFlag: 1,
  edges: [[x,y,x+size,y], [x+size,y,x+size,y+size], [x+size,y+size,x,y+size], [x,y+size,x,y]].map(([a,b,c,d]) => ({ type: 1, start: point(a,b), end: point(c,d) }))
});
const fixture = () => ({ type: 'HATCH', colorIndex: 7, patternName: 'ANSI-test', solidFill: 0, hatchStyle: 0,
  boundaryPaths: [square(0,0,10)], definitionLines: [{ angle: 0, base: point(0,1), offset: point(0,2), dashLengths: [] }] });
const normalize = raw => normalizeCadEntity(raw, undefined, { keepRaw: false, includeUnknownProperties: false });

test('DWG HATCH preserves authored pattern geometry through clone-safe normalization', () => {
  const raw=fixture();
  // Definition lines already carry their final angle and scale.
  raw.patternAngle=Math.PI/2; raw.patternScale=20;
  const entity=normalize(raw);
  assert.equal(entity.hatch.status,'ready');
  assert.equal(entity.hatch.segments.length,5);
  assert.deepEqual(entity.hatch.segments[0],{ start:point(0,1),end:point(10,1) });
  assert.equal(entity.loops[0].vertices.length,4);
  assert.equal(entity.boundaryPaths,undefined);
  assert.deepEqual(structuredClone(entity).hatch,entity.hatch);
});

test('signed HATCH dash lengths retain authored dash and point phases', () => {
  const raw=fixture();raw.definitionLines[0].offset=point(0,20);raw.definitionLines[0].dashLengths=[1,-1,0,-2];
  const entity=normalize(raw);
  assert.equal(entity.hatch.status,'ready');
  assert.deepEqual(entity.hatch.segments.map(s=>[s.start.x,s.end.x]),[[0,1],[4,5],[8,9]]);
  assert.deepEqual(entity.hatch.dots,[point(2,1),point(6,1),point(10,1)]);
});

test('normal island detection clips every pattern line around holes', () => {
  const raw=fixture();raw.boundaryPaths.push(square(3,3,4));raw.definitionLines[0].base=point(0,5);raw.definitionLines[0].offset=point(0,20);
  const entity=normalize(raw);
  assert.equal(entity.hatch.status,'ready');
  assert.equal(entity.loops.length,2);
  assert.deepEqual(entity.hatch.segments,[{start:point(0,5),end:point(3,5)},{start:point(7,5),end:point(10,5)}]);
});

test('unsupported inner boundaries retain source and diagnostics without filling over the hole', () => {
  const raw=fixture();raw.boundaryPaths.push({edges:[{type:2,center:point(5,5),radius:2}]});
  const entity=normalize(raw);
  assert.equal(entity.hatch.status,'unsupported');
  assert.equal(entity.hatch.segments.length,0);
  assert.equal(entity.hatch.source.boundaryPaths.length,2);
  assert.ok(entity.hatch.diagnostics[0].includes('Nonlinear'));
  const doc=normalizeDwgDatabase({entities:[raw]},'unsupported.dwg','AC1032');
  assert.ok(doc.warnings.some(w=>w.includes('HATCH')));
});

test('pattern budgets reject excessive rows, dash cycles and definitions atomically', () => {
  for (const modify of [
    raw=>raw.definitionLines[0].offset=point(0,1e-8),
    raw=>raw.definitionLines[0].dashLengths=[1e-9,-1e-9],
    raw=>raw.definitionLines=Array.from({length:257},()=>raw.definitionLines[0]),
    raw=>raw.definitionLines[0].base=point(1e30,1e30)
  ]) {
    const raw=fixture();modify(raw);const entity=normalize(raw);
    assert.equal(entity.hatch.status,'budget-exceeded');
    assert.equal(entity.hatch.segments.length,0);
    assert.equal(entity.hatch.dots.length,0);
    assert.ok(entity.hatch.source);
  }
});

test('degenerate, open and unsupported island modes do not fabricate HATCH fills', () => {
  for (const modify of [
    raw=>raw.definitionLines[0].offset=point(10,0),
    raw=>raw.definitionLines[0].dashLengths=[0,0],
    raw=>raw.boundaryPaths[0].edges.pop(),
    raw=>{raw.boundaryPaths.push(square(3,3,4));raw.hatchStyle=1;},
    raw=>raw.extrusionDirection={x:0,y:1,z:0}
  ]) {
    const raw=fixture();modify(raw);const entity=normalize(raw);
    assert.equal(entity.hatch.status,'unsupported');
    assert.deepEqual(entity.hatch.segments,[]);
    assert.ok(entity.hatch.diagnostics.length);
  }
});

test('INSERT transforms clipped hatch geometry with its boundary without mutating the block', () => {
  const hatch=normalize(fixture());
  const renderer=Object.create(CadCanvasRenderer.prototype);
  renderer.opts={maxInsertDepth:16};
  renderer.document=createCadDocument({format:'dwg',blocks:{B:{name:'B',basePoint:point(0,0),entities:[hatch]}}});
  let transformed;
  renderer.drawEntityTracked=entity=>{transformed=entity;};
  renderer.drawInsert({type:'INSERT',blockName:'B',insertionPoint:point(100,200),scale:point(2,3),rotation:Math.PI/2},0);
  const segment=transformed.hatch.segments[0];
  for (const [actual,expected] of [[segment.start.x,97],[segment.start.y,200],[segment.end.x,97],[segment.end.y,220]]) assert.ok(Math.abs(actual-expected)<1e-8);
  assert.deepEqual(hatch.hatch.segments[0],{start:point(0,1),end:point(10,1)});
});

test('Canvas and WebGL consume separate clipped segments without bridging holes', () => {
  const raw=fixture();raw.boundaryPaths.push(square(3,3,4));raw.definitionLines[0].base=point(0,5);raw.definitionLines[0].offset=point(0,20);
  const entity=normalize(raw),path=[];
  const canvas=Object.create(CadCanvasRenderer.prototype);
  canvas.stats={drawn:0};canvas.beginStyledPath=()=>{};canvas.worldToScreen=p=>p;
  canvas.ctx={moveTo:(x,y)=>path.push(['M',x,y]),lineTo:(x,y)=>path.push(['L',x,y]),stroke(){},restore(){}};
  canvas.drawHatch(entity);
  assert.deepEqual(path,[['M',0,5],['L',3,5],['M',7,5],['L',10,5]]);
  const gl=Object.create(CadWebGLRenderer.prototype),uploads=[];
  gl.opts={maxVerticesPerBatch:65536,enableSpatialIndex:false};
  gl.gl={ARRAY_BUFFER:1,STATIC_DRAW:1,createBuffer:()=>({}),bindBuffer(){},bufferData(_target,data){uploads.push(data);},deleteBuffer(){}};
  gl.fitToView=()=>{};
  gl.setDocument(createCadDocument({format:'dwg',entities:[entity]}));
  const positions=uploads.find(v=>v instanceof Float32Array);
  assert.deepEqual(Array.from(positions),[-5,0,-2,0,2,0,5,0]);
  assert.equal(gl.scene.lineBatches[0].primitiveCount,2);
  assert.equal(canvas.stats.drawn,1);assert.equal(gl.stats.drawn,1);
  const dotted=fixture();dotted.definitionLines[0].offset=point(0,20);dotted.definitionLines[0].dashLengths=[1,-1,0,-2];
  gl.setDocument(createCadDocument({format:'dwg',entities:[normalize(dotted)]}));
  assert.equal(gl.scene.pointBatches.length,0);
  assert.equal(gl.scene.lineTypePointBatches.reduce((n,b)=>n+b.primitiveCount,0),3);
});
