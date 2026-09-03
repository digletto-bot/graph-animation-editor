import type { AnimationProject, GraphPart, PartDisplayState, PartRole } from './types.ts';

/**
 * Part identity and editor-display resolution.
 *
 * Pure and DOM-free: the Preview renderer imports the ordering helpers, the
 * editor imports the display-state helpers, and neither knows about the other.
 */

/** Stable ids for the three core parts, so migrations and presets can rely on them. */
export const FAR_WING_PART_ID = 'part-far-wing';
export const BODY_PART_ID = 'part-body';
export const NEAR_WING_PART_ID = 'part-near-wing';

/** The three parts a bird always has. They may be renamed but never deleted. */
export const CORE_PART_IDS: readonly string[] = [
  FAR_WING_PART_ID,
  BODY_PART_ID,
  NEAR_WING_PART_ID,
];

/** Gaps of 10 leave room to insert user parts between the core layers. */
export const FAR_WING_Z = 0;
export const BODY_Z = 10;
export const NEAR_WING_Z = 20;

/** Editor overlay colours, so body and near-wing occluders read differently. */
export const PART_EDITOR_COLORS: Record<PartRole, string> = {
  'far-wing': '#f0a05b',
  body: '#5aa2ff',
  'near-wing': '#7cf0c4',
  other: '#c78bf0',
};

export function isCorePart(partId: string): boolean {
  return CORE_PART_IDS.includes(partId);
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

export function partColor(project: AnimationProject, partId: string): string {
  return PART_EDITOR_COLORS[findPart(project, partId)?.role ?? 'other'];
}

export function createDefaultPartDisplay(): PartDisplayState {
  return { locked: false, hidden: false, solo: false, xray: false };
}

export function partDisplayOf(
  display: Record<string, PartDisplayState>,
  partId: string,
): PartDisplayState {
  return display[partId] ?? createDefaultPartDisplay();
}

/**
 * What a part looks like in Edit mode right now.
 *
 * Solo wins over hide: while anything is soloed, non-soloed parts are both
 * invisible and non-interactive, and a soloed part is shown even if its own
 * hide flag is set. Lock never affects visibility, only interaction.
 */
export interface ResolvedPartState {
  visible: boolean;
  /** Selectable, movable, deletable — false when locked or not visible. */
  interactive: boolean;
  locked: boolean;
  xray: boolean;
}

export function resolvePartStates(
  parts: GraphPart[],
  display: Record<string, PartDisplayState>,
): Map<string, ResolvedPartState> {
  const soloing = parts.some((part) => partDisplayOf(display, part.id).solo);
  const result = new Map<string, ResolvedPartState>();
  for (const part of parts) {
    const state = partDisplayOf(display, part.id);
    const visible = soloing ? state.solo : !state.hidden;
    result.set(part.id, {
      visible,
      interactive: visible && !state.locked,
      locked: state.locked,
      // X-ray only means anything for a part that is actually on screen.
      xray: state.xray && visible,
    });
  }
  return result;
}

/** Convenience for callers that only need one part's resolved state. */
export function resolvePartState(
  parts: GraphPart[],
  display: Record<string, PartDisplayState>,
  partId: string,
): ResolvedPartState {
  return (
    resolvePartStates(parts, display).get(partId) ?? {
      visible: true,
      interactive: true,
      locked: false,
      xray: false,
    }
  );
}
