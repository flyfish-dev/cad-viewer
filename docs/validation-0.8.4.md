# 0.8.4 candidate validation

Validated on 2026-11-18 from baseline `0ce90d08bbf96aa780676ffeb81e0da12c575097`.
The candidate is prepared in source; no npm publication or release tag was created.

## Reported DWG

The supplied `测试dwg.dwg` was decoded with the shipped LibreDWG 0.7.9 runtime.
Its SHA-256 is `4d40e6b4f8495800094bd5535fee0b405d1fce42b3bbe46a324b54068f117d79`.
The customer drawing and its screenshots are not committed to this public repository.

The original main branch lost MTEXT reference width, attachment and spacing in the
worker-safe model, then rendered only explicit newlines. A real Canvas2D render
reproduced the notes extending past the drawing border. The repaired model retains
the authored width (138.8724413678024 drawing units), line spacing and text-style
width, and both renderer backends share the same measured wrapping implementation.
Inline width controls override the text-style default without multiplying it twice.

The original broad formatting regular expressions could also expose Unicode escape
digits or remove text through a later semicolon. Synthetic regression fixtures
exercise that failure, escaped literals and malformed controls. The current
LibreDWG output for this supplied file already contains decoded Cyrillic text; the
old screenshot's entire hexadecimal string was not reproduced from that output.

The file additionally contained eight parsed HATCH objects whose boundary and
pattern data never reached either renderer. All eight are now compiled from their
embedded line-pattern definitions, producing 1,676 clipped line segments and
334 dots. The model has 585 entities; the real Canvas2D check changed from
577 drawn / 8 skipped to 585 drawn / 0 skipped. This is entity/geometry coverage,
not a claim of pixel-identical font rendering.

## Local release checks

| Check | Result |
| --- | --- |
| `npm ci --no-audit --no-fund` | Passed with the committed dependency lock |
| `npm run build` | Passed: typecheck, ES/UMD library, worker, declarations, assets and demo |
| `node --test test/*.test.mjs .github/scripts/*.test.mjs` | 104 passed, 0 failed, 0 skipped |
| Strict NodeNext and Bundler declaration consumers | Passed as part of the regression suite |
| `npm pack --json` | 79 package entries; 3,144,380 compressed bytes |
| Clean installation of the generated tarball | Passed using ordinary npm dependencies |
| Installed package ES module and WASM assets | Imported successfully; WASM magic bytes verified |
| Installed `dist/wasm/dwg-worker.js` with real input | Passed in a Node worker host; production assets and structured-clone messages used |
| Installed worker result | 585 entities, expected MTEXT fields, all 8 HATCH objects ready, no warnings |
| Actual Canvas2D drawing and font measurement | Passed using a native Canvas implementation and locally available fonts |
| Browser end-to-end / GPU frame inspection | **Not completed**: Chromium IPC startup and cloud-browser local-file navigation were blocked by environment policy |

Tarball SHA-1: `33154e25826d9682427ab7770e98e62785b3a19e`.
The Node worker host provides filesystem-backed fetch for the local packaged WASM;
it verifies the actual shipped worker/parser path but does not replace browser
worker-loading, DOM or GPU acceptance.

## Issues and pull requests

| Item | Result |
| --- | --- |
| [PR #7](https://github.com/flyfish-dev/cad-viewer/pull/7), [issue #5](https://github.com/flyfish-dev/cad-viewer/issues/5) | Original failures reproduced; PR merged, with additional strict UTF-8, BOM, escaped-literal and attribute regressions in this candidate |
| [PR #8](https://github.com/flyfish-dev/cad-viewer/pull/8), [issue #6](https://github.com/flyfish-dev/cad-viewer/issues/6) | Original missing-layer failure reproduced; PR merged, with additional layer flags, true color, linetype, lineweight and special-name coverage |
| [Issue #2](https://github.com/flyfish-dev/cad-viewer/issues/2) | Upstream implementation completed; remains open until normal npm dependency delivery is verified |

PR #7 was reviewed at `9765d24509e86347ab31a4342a3b4bbdd8758484`; PR #8 at
`047fce35c52277d30f2867f6a7cf385f1e9e560f`. Their fork workflow status was
`action_required`; the local reproductions and tests above supplied the validation.

Issue #2 is fixed in the [dwf-viewer 0.6.8 candidate commit](https://github.com/flyfish-dev/dwf-viewer/commit/274e7c86af0c97c569176c43ff317e92b0e30584).
The original public attachment previously stopped after 905 primitives at byte
18,429, opcode `0x07`. The repaired upstream parser completes 82,063 primitives and
84,628 opcodes with no unsupported-opcode diagnostics. Eleven new Gouraud parser,
color, transparency and bounded-render-work regressions pass, alongside the
upstream production and package checks.

The published dependency is still `dwf-viewer@0.6.7`; this candidate deliberately
keeps a resolvable npm dependency. Do not close #2 based only on the upstream source
commit. Publish 0.6.8, update the minimum version and lockfile here, then verify the
original attachment with the installed dependency before closing it.

## Fidelity boundaries

- SHX text faces are external to the drawing. This patch preserves their layout
  metrics but still uses available font fallback for text glyphs.
- Full CAD rich text, complex tabs, stacked fractions, inline color/oblique/tracking
  and CJK punctuation rules are not advertised as complete by this change.
- New HATCH compilation covers closed straight boundaries and embedded line/dot
  patterns with normal island detection. Curves, gradients, non-WCS extrusion and
  unsupported island modes retain source data and diagnostics. Geometry budgets
  prevent partial or unbounded pattern generation.
- Diagnostics from unreferenced blocks remain on those entities and do not create
  misleading warnings about the visible model.
