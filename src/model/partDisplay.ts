import type { AnimationProject, GraphPart, PartDisplayState, PartRole } from './types.ts';
import { findPart } from '../runtime/parts.ts';

/**
 * Editor-only part display: overlay colours and how lock/hide/solo/x-ray
 * resolve into what the stage shows.
 *
 * None of this is exported with the animation or reachable from the player;
 * part identity and render order live in `runtime/parts.ts`.
 */

/** Editor overlay colours, so occluders on different roles read differently. */
export const PART_EDITOR_COLORS: Record<PartRole, string> = {
  'far-wing': '#f0a05b',
  body: '#5aa2ff',
  'near-wing': '#7cf0c4',
  other: '#c78bf0',
};

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
