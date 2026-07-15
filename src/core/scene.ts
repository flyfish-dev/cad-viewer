import type { CadDocument, CadSceneTransform2D } from './types';
import { IDENTITY_MATRIX, transformEntity } from './transform';

const isIdentity = (matrix: CadSceneTransform2D) => {
  return Math.abs(matrix.a - 1) < 1e-12
    && Math.abs(matrix.b) < 1e-12
    && Math.abs(matrix.c) < 1e-12
    && Math.abs(matrix.d - 1) < 1e-12
    && Math.abs(matrix.e) < 1e-9
    && Math.abs(matrix.f) < 1e-9;
};

/**
 * Produces the one normalized coordinate space consumed by bounds, both
 * renderers, overlay text and future hit testing. The parser-owned document is
 * left untouched so callers can still inspect original WCS coordinates.
 */
export function createCadSceneDocument(document: CadDocument): CadDocument {
  if (document.metadata.sceneTransformApplied === true) return document;
  if (document.savedView?.sceneTransformApplied === false) return document;
  const matrix = document.savedView?.sceneTransform ?? IDENTITY_MATRIX;
  if (isIdentity(matrix)) return document;
  return {
    ...document,
    entities: document.entities.map((entity) => transformEntity(entity, matrix)),
    pages: document.pages?.map((page) => ({
      ...page,
      entities: page.entities.map((entity) => transformEntity(entity, matrix))
    })),
    metadata: {
      ...document.metadata,
      sceneTransformApplied: true
    }
  };
}
