import type { CadDocument } from './types';

export type CadColorMode = 'source' | 'monochrome';

export interface CadColorPolicy {
  /** Preserve authored colors or replace renderable CAD colors with one fixed color. */
  mode?: CadColorMode;
  /** CSS color used when mode is `monochrome`. Defaults to the active renderer foreground. */
  monochromeColor?: string;
}

const COLOR_MODE_KEY = 'cadColorMode';
const MONOCHROME_COLOR_KEY = 'cadMonochromeColor';

/**
 * Creates a shallow render-only document view carrying a color policy in
 * metadata. Geometry, layers, entities, parser data and the caller-owned
 * document remain untouched.
 */
export function createCadRenderDocument(
  document: CadDocument,
  policy: CadColorPolicy = {}
): CadDocument {
  const mode = policy.mode ?? 'source';
  const current = readCadColorPolicy(document);
  const nextColor = normalizeOptionalColor(policy.monochromeColor);

  if (
    current.mode === mode &&
    current.monochromeColor === nextColor
  ) {
    return document;
  }

  const metadata = { ...document.metadata };
  if (mode === 'monochrome') {
    metadata[COLOR_MODE_KEY] = mode;
    if (nextColor) metadata[MONOCHROME_COLOR_KEY] = nextColor;
    else delete metadata[MONOCHROME_COLOR_KEY];
  } else {
    delete metadata[COLOR_MODE_KEY];
    delete metadata[MONOCHROME_COLOR_KEY];
  }

  return { ...document, metadata };
}

/** Reads the render-only color policy attached by createCadRenderDocument(). */
export function readCadColorPolicy(document?: CadDocument): Required<Pick<CadColorPolicy, 'mode'>> & Pick<CadColorPolicy, 'monochromeColor'> {
  const metadata = document?.metadata;
  const mode = metadata?.[COLOR_MODE_KEY] === 'monochrome' ? 'monochrome' : 'source';
  const monochromeColor = normalizeOptionalColor(metadata?.[MONOCHROME_COLOR_KEY]);
  return monochromeColor ? { mode, monochromeColor } : { mode };
}

function normalizeOptionalColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}
