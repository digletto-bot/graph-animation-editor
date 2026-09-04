import type { AnimationProject, GraphPart } from './types.ts';

/**
 * Part identity and render ordering.
 *
 * Everything here answers a question about the document itself — which layers
 * exist and in what order they draw — so the player and the editor share it.
 * Editor-only display state (lock, hide, solo, x-ray) lives in
 * `model/partDisplay.ts` and is deliberately unreachable from a rendered frame.
 */

/** The single layer a new project starts with. */
export const DEFAULT_PART_ID = 'part-1';

/**
 * Ids of the bird preset's three layers. Nothing creates them any more; they
 * are kept so files written by earlier builds keep their roles and colours.
 */
export const FAR_WING_PART_ID = 'part-far-wing';
export const BODY_PART_ID = 'part-body';
export const NEAR_WING_PART_ID = 'part-near-wing';

/** Gaps of 10 leave room to insert parts between existing layers. */
export const FAR_WING_Z = 0;
export const BODY_Z = 10;
export const NEAR_WING_Z = 20;

/**
 * The last remaining part cannot be deleted: every node, edge and occluder
 * needs a layer to live on, so the project always keeps at least one.
 */
export function isLastPart(project: AnimationProject, partId: string): boolean {
  return project.parts.length <= 1 && project.parts.some((part) => part.id === partId);
}

/** Back to front. Ties break on array order so the result is deterministic. */
export function sortPartsByZ(parts: GraphPart[]): GraphPart[] {
  return parts
    .map((part, index) => ({ part, index }))
    .sort((a, b) => a.part.zIndex - b.part.zIndex || a.index - b.index)
    .map((entry) => entry.part);
}

/** Parts drawn in production, back to front. Editor state is deliberately ignored. */
export function renderablePartsInOrder(project: AnimationProject): GraphPart[] {
  return sortPartsByZ(project.parts).filter((part) => part.renderEnabled);
}

export function findPart(project: AnimationProject, partId: string): GraphPart | undefined {
  return project.parts.find((part) => part.id === partId);
}
