import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyByBlockLineTypeInheritance,
  CadShxFontRegistry,
  cadEntityWorldStrokeWidth,
  computeCadDocumentBounds,
  createCadSceneDocument,
  createDashedCadPrimitives,
  createDashedCadSegments,
  isCadPolylineClosed,
  normalizeDwgDatabase,
  resolveCadFitBounds,
  resolveCadSavedViewBounds,
  resolveCadLinePattern,
  transformCadLineTypeGlyph
} from '../dist/cad-viewer.es.js';

const nearlyEqual = (actual, expected, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should equal ${expected}`);
};

const fixture = () => ({
  header: {
    LTSCALE: 2,
    CELTSCALE: 7,
    UCSORG: { x: 0, y: 0, z: 0 },
    UCSXDIR: { x: 1, y: 0, z: 0 },
    UCSYDIR: { x: 0, y: 1, z: 0 }
  },
  tables: {
    LAYER: {
      entries: [{ name: 'fixture-layer', lineType: 'A1', colorIndex: 7 }]
    },
    LTYPE: {
      entries: [
        { handle: '16', name: 'Continuous', totalPatternLength: 0, pattern: [] },
        {
          handle: 'A1',
          name: 'FixtureDash',
          totalPatternLength: 3,
          pattern: [{ elementLength: 2 }, { elementLength: -1 }]
        },
        {
          handle: 'A2',
          name: 'FixtureComplex',
          totalPatternLength: 2,
          pattern: [{ elementLength: 0, elementTypeFlag: 5, shapeNumber: 4, styleObjectId: '5A' }, { elementLength: -2, elementTypeFlag: 5, shapeNumber: 4, styleObjectId: '5A' }]
        },
        {
          handle: 'A3',
          name: 'FixtureComplexPositive',
          totalPatternLength: 2,
          pattern: [{ elementLength: 1, elementTypeFlag: 5, shapeNumber: 4, styleObjectId: '5A' }, { elementLength: 1 }]
        }
      ]
    },
    STYLE: {
      entries: [{ handle: '5A', name: '', standardFlag: 65, font: 'FixtureShapes.SHX' }]
    },
    VPORT: {
      entries: [{
        handle: 'ORDINARY',
        name: 'Named view',
        viewTwistAngle: 0.25
      }, {
        handle: 'VP1',
        name: '*Active',
        center: { x: 10, y: 20 },
        viewTarget: { x: 0, y: 0, z: 0 },
        viewDirectionFromTarget: { x: 0, y: 0, z: 1 },
        viewTwistAngle: Math.PI / 2,
        viewHeight: 100,
        aspectRatio: 2,
        ucsOrigin: { x: 0, y: 0, z: 0 },
        ucsXAxis: { x: 1, y: 0, z: 0 },
        ucsYAxis: { x: 0, y: 1, z: 0 }
      }, {
        handle: 'VP2',
        name: '*ACTIVE',
        viewTwistAngle: -Math.PI / 2
      }]
    }
  },
  entities: [
    {
      type: 'LWPOLYLINE',
      handle: 'CLOSED-200',
      layer: 'fixture-layer',
      lineType: 'ByLayer',
      lineTypeScale: 3,
      constantWidth: 1.6,
      flag: 0x200,
      vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }]
    },
    {
      type: 'POLYLINE3D',
      handle: 'CLOSED-1',
      layer: 'fixture-layer',
      lineType: 'FixtureDash',
      flag: 1,
      vertices: [{ x: 0, y: 0 }, { x: 2, y: 0 }]
    },
    {
      type: 'LINE',
      handle: 'DEFAULT-CELTSCALE',
      layer: 'fixture-layer',
      lineType: 'FixtureDash',
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 100, y: 0 }
    },
    {
      type: 'LWPOLYLINE',
      handle: 'LWP-WRONG-FLAG',
      layer: 'fixture-layer',
      flag: 1,
      vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }]
    },
    {
      type: 'LWPOLYLINE',
      handle: 'GEOMETRICALLY-CLOSED',
      layer: 'fixture-layer',
      flag: 0,
      vertices: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }, { x: 0, y: 0 }]
    },
    {
      type: 'TEXT',
      handle: 'ROTATED-TEXT',
      layer: 'fixture-layer',
      insertionPoint: { x: 1, y: 0 },
      rotation: 0,
      text: 'fixture',
      height: 1,
      xScale: 0.8,
      generationFlag: 0,
      halign: 1,
      valign: 2,
      extrusionDirection: { x: 0, y: 0, z: 1 }
    },
    {
      type: 'ARC',
      handle: 'ROTATED-ARC',
      layer: 'fixture-layer',
      center: { x: 2, y: 0 },
      radius: 1,
      startAngle: 0.25,
      endAngle: 1.25
    },
    {
      type: 'ELLIPSE',
      handle: 'ROTATED-ELLIPSE',
      layer: 'fixture-layer',
      center: { x: 2, y: 0 },
      majorAxisEndPoint: { x: 2, y: 0 },
      axisRatio: 0.5,
      startAngle: 0.25,
      endAngle: 1.25
    },
    {
      type: 'INSERT',
      handle: 'INSERT-WITH-ATTRIB',
      layer: 'fixture-layer',
      insertionPoint: { x: 2, y: 0 },
      rotation: 0,
      attribs: [{
        type: 'ATTRIB',
        handle: 'NESTED-ATTRIB',
        layer: 'fixture-layer',
        insertionPoint: { x: 2.5, y: 0 },
        rotation: 0,
        text: 'attribute',
        height: 1
      }]
    },
    {
      type: 'INSERT',
      handle: 'CANONICAL-ROTATION',
      layer: 'fixture-layer',
      insertionPoint: { x: 3, y: 0 },
      rotation: Math.PI * 1.5,
      scale: { x: 2, y: 3, z: 1 }
    }
  ]
});

test('DWG normalization keeps both close flags, LTYPE definitions and active VPORT metadata', () => {
  const document = normalizeDwgDatabase(fixture(), 'generated-fixture.dwg', { release: 'fixture' }, { keepRaw: false });
  const closed200 = document.entities.find((entity) => entity.handle === 'CLOSED-200');
  const closed1 = document.entities.find((entity) => entity.handle === 'CLOSED-1');

  assert.equal(closed200?.flag, 0x200);
  assert.equal(closed200?.isClosed, true);
  assert.equal(closed200?.constantWidth, 1.6);
  assert.equal(cadEntityWorldStrokeWidth(closed200), 1.6);
  assert.equal(closed200?.raw, undefined);
  assert.equal(closed1?.flag, 1);
  assert.equal(closed1?.isClosed, true);
  assert.notEqual(document.entities.find((entity) => entity.handle === 'LWP-WRONG-FLAG')?.isClosed, true);
  assert.equal(isCadPolylineClosed(document.entities.find((entity) => entity.handle === 'GEOMETRICALLY-CLOSED')), true);
  assert.equal(isCadPolylineClosed({ type: 'SOLID', vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }] }), false);
  const normalizedText = document.entities.find((entity) => entity.handle === 'ROTATED-TEXT');
  const normalizedInsert = document.entities.find((entity) => entity.handle === 'CANONICAL-ROTATION');
  assert.equal(normalizedText?.xScale, 0.8);
  assert.equal(normalizedText?.generationFlag, 0);
  assert.equal(normalizedText?.halign, 1);
  assert.equal(normalizedText?.valign, 2);
  assert.deepEqual(normalizedText?.extrusionDirection, { x: 0, y: 0, z: 1 });
  assert.deepEqual(normalizedInsert?.scale, { x: 2, y: 3, z: 1 });
  assert.equal(document.lineTypes?.A1?.name, 'FixtureDash');
  assert.deepEqual(document.lineTypes?.FixtureDash?.pattern.map((part) => part.length), [2, -1]);
  assert.equal(document.lineTypes?.A2?.pattern[0]?.elementTypeFlag, 4, 'LibreDWG shape_flag is DXF group 74');
  assert.equal(document.lineTypes?.A2?.pattern[0]?.shapeNumber, 5, 'LibreDWG complex_shapecode is DXF group 75');
  assert.equal(document.lineTypes?.A2?.pattern[0]?.styleHandle, '5A');
  assert.equal(document.lineTypes?.A2?.pattern[0]?.fontName, 'FixtureShapes.SHX');
  assert.equal(document.savedView?.source, 'vport');
  assert.equal(document.savedView?.handle, 'VP1');
  assert.equal(document.savedView?.sceneTransformApplied, true);
  assert.deepEqual(document.metadata.requiredShxFonts, ['FixtureShapes.SHX']);
  nearlyEqual(document.savedView?.twistAngle, Math.PI / 2);
  assert.ok(document.warnings.some((warning) => warning.includes('Complex SHX linetype glyphs')));
  assert.ok(document.warnings.some((warning) => warning.includes('FixtureShapes.SHX')));
});

test('ordinary named VPORT entries do not override header UCS when no *ACTIVE exists', () => {
  const raw = fixture();
  raw.tables.VPORT.entries = [{ handle: 'ORDINARY', name: 'Named view', viewTwistAngle: 0.75 }];
  raw.header.VIEWDIR = { x: 0, y: 0, z: 1 };
  raw.header.UCSXDIR = { x: 0, y: 1, z: 0 };
  raw.header.UCSYDIR = { x: -1, y: 0, z: 0 };
  const document = normalizeDwgDatabase(raw, 'generated-fixture.dwg', undefined, { keepRaw: false });
  assert.equal(document.savedView?.source, 'header-ucs');
  assert.equal(document.savedView?.handle, undefined);
  nearlyEqual(document.savedView?.sceneTransform.a, 0);
  nearlyEqual(document.savedView?.sceneTransform.b, -1);
  nearlyEqual(document.savedView?.sceneTransform.c, 1);
  nearlyEqual(document.savedView?.sceneTransform.d, 0);
});

test('unused SHX STYLE records do not create false missing-reference requirements', () => {
  const raw = fixture();
  raw.tables.LTYPE.entries = raw.tables.LTYPE.entries.filter(({ name }) => name !== 'FixtureComplex' && name !== 'FixtureComplexPositive');
  const document = normalizeDwgDatabase(raw, 'unused-shape-style.dwg', undefined, { keepRaw: false });

  assert.deepEqual(document.metadata.requiredShxFonts, []);
  const registry = new CadShxFontRegistry();
  registry.setDocument(document);
  assert.deepEqual(registry.getState().missing, []);
});

test('one scene transform rotates geometry and overlay text exactly once', () => {
  const source = normalizeDwgDatabase(fixture(), 'generated-fixture.dwg', undefined, { keepRaw: false });
  const scene = createCadSceneDocument(source);
  const text = scene.entities.find((entity) => entity.handle === 'ROTATED-TEXT');
  const arc = scene.entities.find((entity) => entity.handle === 'ROTATED-ARC');
  const ellipse = scene.entities.find((entity) => entity.handle === 'ROTATED-ELLIPSE');
  const insert = scene.entities.find((entity) => entity.handle === 'INSERT-WITH-ATTRIB');
  const canonicalInsert = scene.entities.find((entity) => entity.handle === 'CANONICAL-ROTATION');
  const attrib = insert?.attribs?.[0];

  nearlyEqual(text?.insertionPoint?.x, 0);
  nearlyEqual(text?.insertionPoint?.y, 1);
  nearlyEqual(text?.rotation, Math.PI / 2);
  nearlyEqual(arc?.startAngle, 0.25 + Math.PI / 2);
  nearlyEqual(arc?.endAngle, 1.25 + Math.PI / 2);
  nearlyEqual(ellipse?.majorAxisEndPoint?.x, 0);
  nearlyEqual(ellipse?.majorAxisEndPoint?.y, 2);
  nearlyEqual(ellipse?.startAngle, 0.25, 1e-12);
  nearlyEqual(ellipse?.endAngle, 1.25, 1e-12);
  nearlyEqual(insert?.insertionPoint?.x, 0);
  nearlyEqual(insert?.insertionPoint?.y, 2);
  nearlyEqual(insert?.rotation, Math.PI / 2);
  nearlyEqual(attrib?.insertionPoint?.x, 0);
  nearlyEqual(attrib?.insertionPoint?.y, 2.5);
  nearlyEqual(attrib?.rotation, Math.PI / 2);
  assert.equal(canonicalInsert?.rotation, 0, 'a full-turn block rotation is canonicalized after PLAN composition');
  assert.deepEqual(canonicalInsert?.scale, { x: 2, y: 3, z: 1 }, 'worker-safe INSERT scale survives the scene transform');
  assert.equal(transformCadRotationOnly(source)?.rotation, 0, 'a full-turn entity rotation is canonicalized without an extra scene rotation');
  assert.deepEqual(source.entities.find((entity) => entity.handle === 'ROTATED-TEXT')?.insertionPoint, { x: 1, y: 0 });
  assert.equal(createCadSceneDocument(scene), scene, 'scene transform must be idempotent');
});

function transformCadRotationOnly(source) {
  const canonical = source.entities.find((entity) => entity.handle === 'CANONICAL-ROTATION');
  if (!canonical) return undefined;
  return createCadSceneDocument({
    ...source,
    entities: [{ ...canonical, rotation: Math.PI * 2 }],
    savedView: {
      sceneTransformApplied: true,
      sceneTransform: { a: 1, b: 0, c: 0, d: 1, e: 1, f: 0 }
    },
    metadata: {}
  }).entities[0];
}

test('missing, non-finite or tilted VIEWDIR keeps world coordinates and warns', () => {
  const invalidDirections = [
    undefined,
    { x: 0, y: 0, z: Number.NaN },
    { x: 1, y: 0, z: 1 }
  ];
  for (const direction of invalidDirections) {
    const raw = fixture();
    raw.tables.VPORT.entries = [{
      handle: 'INVALID-ACTIVE',
      name: '*Active',
      viewDirectionFromTarget: direction,
      viewTwistAngle: Math.PI / 3
    }];
    const document = normalizeDwgDatabase(raw, 'generated-fixture.dwg', undefined, { keepRaw: false });
    assert.equal(document.savedView?.sceneTransformApplied, false);
    assert.deepEqual(document.savedView?.sceneTransform, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    assert.ok(document.warnings.some((warning) => warning.includes('kept world coordinates')));
    assert.equal(createCadSceneDocument(document), document, 'an unsafe saved view must not create a scene clone');
  }
});

test('saved DWG viewport keeps remote coordinate clusters out of the automatic initial fit', () => {
  const document = normalizeDwgDatabase({
    tables: {
      VPORT: {
        entries: [{
          handle: 'ACTIVE-SHEET',
          name: '*Active',
          center: { x: 420, y: 297 },
          viewDirectionFromTarget: { x: 0, y: 0, z: 1 },
          viewHeight: 1420,
          aspectRatio: 2.146
        }]
      }
    },
    entities: [{
      type: 'LINE',
      handle: 'SHEET-DIAGONAL',
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 840, y: 594 }
    }, {
      type: 'LINE',
      handle: 'REMOTE-SURVEY',
      startPoint: { x: -3_059_307, y: -1_780_563 },
      endPoint: { x: -3_058_337, y: -1_779_882 }
    }]
  }, 'remote-cluster.dwg');
  const scene = createCadSceneDocument(document);
  const extents = computeCadDocumentBounds(scene);
  const savedView = resolveCadSavedViewBounds(scene);
  const automatic = resolveCadFitBounds(scene, extents, 'auto');

  assert.ok(extents.minX < -3_000_000, 'full extents must retain the remote survey geometry');
  nearlyEqual(savedView?.minX, 420 - 1420 * 2.146 / 2);
  nearlyEqual(savedView?.maxX, 420 + 1420 * 2.146 / 2);
  nearlyEqual(savedView?.minY, -413);
  nearlyEqual(savedView?.maxY, 1007);
  nearlyEqual(automatic.minX, -16.8);
  nearlyEqual(automatic.minY, -11.88);
  nearlyEqual(automatic.maxX, 856.8);
  nearlyEqual(automatic.maxY, 605.88);
  assert.deepEqual(resolveCadFitBounds(scene, extents, 'saved-view'), savedView);
  assert.deepEqual(resolveCadFitBounds(scene, extents, 'extents'), extents);
});

test('line patterns resolve handle/layer inheritance and stable world-unit scaling', () => {
  const document = normalizeDwgDatabase(fixture(), 'generated-fixture.dwg', undefined, { keepRaw: false });
  const explicitScale = document.entities.find((entity) => entity.handle === 'CLOSED-200');
  const defaultScale = document.entities.find((entity) => entity.handle === 'DEFAULT-CELTSCALE');
  const explicitPattern = resolveCadLinePattern(explicitScale, document);
  const defaultPattern = resolveCadLinePattern(defaultScale, document);

  assert.deepEqual(explicitPattern?.segments, [12, 6], 'LTSCALE 2 * stored entity scale 3');
  assert.deepEqual(defaultPattern?.segments, [28, 14], 'CELTSCALE 7 is only the missing entity-scale default');
  const dashed = createDashedCadSegments([{ x: 0, y: 0 }, { x: 40, y: 0 }], false, explicitPattern);
  assert.ok(dashed.length >= 3);
  assert.ok(dashed.every(([start, end]) => end.x > start.x));
  assert.ok(dashed.some(([, end], index) => index > 0 && end.x < 40));
});

test('complex LTYPE keeps group-49 dash signs and renders zero dots as markers', () => {
  const document = normalizeDwgDatabase(fixture(), 'generated-fixture.dwg', undefined, { keepRaw: false });
  const zeroDot = resolveCadLinePattern({ type: 'LINE', lineType: 'A2', lineTypeScale: 1 }, document);
  const positiveComplex = resolveCadLinePattern({ type: 'LINE', lineType: 'A3', lineTypeScale: 1 }, document);

  assert.equal(zeroDot?.period, 4, 'LTSCALE 2 scales the exact 2-unit phase without adding dot width');
  assert.deepEqual(zeroDot?.runs.map(({ draw, length, marker }) => ({ draw, length, marker })), [
    { draw: true, length: 0, marker: true },
    { draw: false, length: 4, marker: false }
  ]);
  const dotted = createDashedCadPrimitives([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, zeroDot);
  assert.deepEqual(dotted.segments, []);
  assert.deepEqual(dotted.dots.map((point) => point.x), [0, 4, 8]);
  assert.deepEqual(dotted.markers?.map(({ kind, shapeNumber, fontName }) => ({ kind, shapeNumber, fontName })), [
    { kind: 'shape', shapeNumber: 5, fontName: 'FixtureShapes.SHX' },
    { kind: 'shape', shapeNumber: 5, fontName: 'FixtureShapes.SHX' },
    { kind: 'shape', shapeNumber: 5, fontName: 'FixtureShapes.SHX' }
  ]);

  assert.deepEqual(positiveComplex?.runs.map(({ draw, length, marker }) => ({ draw, length, marker })), [
    { draw: true, length: 2, marker: true },
    { draw: true, length: 2, marker: false }
  ], 'a complex positive element remains a positive baseline dash');
  const solidWithGlyphs = createDashedCadPrimitives([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, positiveComplex);
  assert.equal(solidWithGlyphs.segments.reduce((sum, [start, end]) => sum + end.x - start.x, 0), 10);
  assert.deepEqual(solidWithGlyphs.dots.map((point) => point.x), [0, 4, 8]);
});

test('ByBlock linetype and entity scale inherit from the parent INSERT', () => {
  const document = normalizeDwgDatabase(fixture(), 'generated-fixture.dwg', undefined, { keepRaw: false });
  const inherited = applyByBlockLineTypeInheritance(
    { type: 'LINE', lineType: 'ByBlock', lineTypeScale: 3 },
    { type: 'INSERT', lineType: 'FixtureDash', lineTypeScale: 2 },
    document
  );
  assert.equal(inherited.lineType, 'FixtureDash');
  assert.equal(inherited.lineTypeScale, 6);
  assert.deepEqual(resolveCadLinePattern(inherited, document)?.segments, [24, 12]);
});

test('pathological microscopic patterns degrade to visible source edges instead of unbounded expansion', () => {
  const primitives = createDashedCadPrimitives(
    [{ x: 0, y: 0 }, { x: 1_000_000, y: 0 }],
    false,
    {
      name: 'pathological',
      segments: [1e-9, 1e-9],
      runs: [
        { draw: true, length: 1e-9, marker: false },
        { draw: false, length: 1e-9, marker: false }
      ],
      period: 2e-9
    }
  );
  assert.deepEqual(primitives, {
    segments: [[{ x: 0, y: 0 }, { x: 1_000_000, y: 0 }]],
    dots: []
  });
});

test('complex LTYPE markers preserve local offsets, scale and relative or absolute rotation', () => {
  const document = {
    format: 'dwg',
    header: { LTSCALE: 2, CELTSCALE: 1 },
    layers: {},
    blocks: {},
    entities: [],
    metadata: {},
    warnings: [],
    lineTypes: {
      Complex: {
        name: 'Complex',
        pattern: [
          { length: 0, elementTypeFlag: 4, shapeNumber: 5, scale: 0.5, rotation: 0.25, offsetX: 1, offsetY: 2, fontName: 'FixtureShapes.SHX' },
          { length: -4 }
        ]
      }
    }
  };
  const relative = resolveCadLinePattern({ type: 'LINE', lineType: 'Complex', lineTypeScale: 1 }, document);
  const primitives = createDashedCadPrimitives([{ x: 10, y: 20 }, { x: 10, y: 40 }], false, relative);
  const marker = primitives.markers?.[0];
  assert.ok(marker);
  assert.deepEqual(marker.fallbackPoint, { x: 10, y: 20 });
  assert.deepEqual(marker.point, { x: 6, y: 22 });
  nearlyEqual(marker.scale, 1);
  nearlyEqual(marker.angle, Math.PI / 2 + 0.25);

  const transformed = transformCadLineTypeGlyph(marker, { polylines: [[{ x: 0, y: 0 }, { x: 1, y: 0 }]] });
  nearlyEqual(transformed[0][0].x, 6);
  nearlyEqual(transformed[0][0].y, 22);
  nearlyEqual(transformed[0][1].x, 6 + Math.cos(Math.PI / 2 + 0.25));
  nearlyEqual(transformed[0][1].y, 22 + Math.sin(Math.PI / 2 + 0.25));

  document.lineTypes.Complex.pattern[0].elementTypeFlag = 5;
  const absolute = resolveCadLinePattern({ type: 'LINE', lineType: 'Complex', lineTypeScale: 1 }, document);
  const absoluteMarker = createDashedCadPrimitives([{ x: 10, y: 20 }, { x: 10, y: 40 }], false, absolute).markers?.[0];
  nearlyEqual(absoluteMarker?.angle, 0.25);
});

test('SHX registry validates required glyphs and replaces fallback geometry from buffer content', async () => {
  const document = normalizeDwgDatabase(fixture(), 'generated-fixture.dwg', undefined, { keepRaw: false });
  const registry = new CadShxFontRegistry();
  registry.setDocument(document);
  assert.deepEqual(registry.getState().missing, [{
    kind: 'shx',
    fileName: 'FixtureShapes.SHX',
    identified: true,
    reason: 'not-loaded'
  }]);

  await registry.add({ fileName: 'FixtureShapes.SHX', buffer: buildMinimalShapesShx([6]) });
  assert.equal(registry.getState().missing[0]?.reason, 'incompatible');

  const source = new Uint8Array(buildMinimalShapesShx([5]));
  const padded = new Uint8Array(source.length + 4);
  padded.set(source, 2);
  const loaded = await registry.add({ fileName: 'FixtureShapes.SHX', buffer: padded.subarray(2, padded.length - 2) });
  assert.equal(loaded.glyphCount, 1);
  assert.equal(loaded.fontType, 'shapes');
  assert.deepEqual(registry.getState().missing, []);
  assert.ok(registry.resolveShape(5, 'FixtureShapes.SHX')?.polylines.length);
  registry.clear();
});

test('SHX registry lays out complex-linetype text from API-provided bytes', async () => {
  const document = {
    format: 'dwg',
    layers: {},
    blocks: {},
    entities: [],
    metadata: { requiredShxFonts: ['FixtureText.SHX'] },
    warnings: [],
    lineTypes: {
      TextComplex: {
        name: 'TextComplex',
        pattern: [{ length: 0, elementTypeFlag: 2, text: 'AB', fontName: 'FixtureText.SHX' }, { length: -1 }]
      }
    }
  };
  const registry = new CadShxFontRegistry();
  registry.setDocument(document);
  await registry.add({ fileName: 'fixturetext.shx', buffer: buildMinimalShapesShx([65, 66], true) });

  assert.deepEqual(registry.getState().missing, []);
  const glyph = registry.resolveText('AB', 'FixtureText.SHX');
  assert.ok(glyph?.polylines.length >= 2);
  assert.ok(Math.max(...glyph.polylines.flat().map(({ x }) => x)) > 0.15, 'the second glyph advances along the baseline');
  registry.clear();
});

function buildMinimalShapesShx(codes, includeFontInfo = false) {
  const encoder = new TextEncoder();
  const header = encoder.encode('AutoCAD-86 shapes V1.0\r\n\x1a');
  const entries = codes.map((code) => ({
    code,
    raw: new Uint8Array([...encoder.encode(`S${code}`), 0, 0x14, 0x10, 0x1c, 0x18, 0x12, 0])
  }));
  if (includeFontInfo) {
    entries.unshift({ code: 0, raw: new Uint8Array([...encoder.encode('Fixture text font'), 0, 8, 2, 0]) });
  }
  const tableSize = 6 + entries.length * 4;
  const dataSize = entries.reduce((sum, entry) => sum + entry.raw.length, 0);
  const buffer = new ArrayBuffer(header.length + tableSize + dataSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(header);
  let offset = header.length;
  view.setInt16(offset, 0, true); offset += 2;
  view.setInt16(offset, 0, true); offset += 2;
  view.setInt16(offset, entries.length, true); offset += 2;
  let dataOffset = header.length + tableSize;
  for (const entry of entries) {
    view.setUint16(offset, entry.code, true); offset += 2;
    view.setUint16(offset, entry.raw.length, true); offset += 2;
    bytes.set(entry.raw, dataOffset);
    dataOffset += entry.raw.length;
  }
  return buffer;
}
