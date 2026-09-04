/**
 * Node point geometry for the preview renderer.
 *
 * Kept apart from PreviewRenderer so the maths can be exercised without a real
 * 2D context.
 *
 * Nodes are drawn artwork: every node renders as a glowing point whose size
 * comes from its `width` and whose intensity comes from its `brightness`. The
 * separate "Show nodes in preview" setting is an unrelated flat helper overlay
 * for checking placement, and deliberately ignores both.
 */

/** Opacity of the bright core at brightness 1. */
export const NODE_CORE_ALPHA = 0.85;
/** Opacity of the additive halo at brightness 1. */
export const NODE_GLOW_ALPHA = 0.22;
/** Flat helper-overlay dot opacity. Fixed: the helper is not artwork. */
export const NODE_HELPER_ALPHA = 0.75;
/** Flat helper-overlay dot radius, in the same units as a default node width. */
export const NODE_HELPER_WIDTH = 1.6;

/** Node points read a touch larger than their width alone. */
const RADIUS_GAIN = 1.2;
/** How much wider the halo is than the core, matching the edge glow ratio. */
const GLOW_GAIN = 2.4;

/**
 * Core radius in device pixels. Never smaller than 1, or a thin node would
 * vanish entirely at small canvas sizes.
 */
export function nodeDotRadius(width: number, strokeScale: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(strokeScale)) return 1;
  return Math.max(1, width * strokeScale * RADIUS_GAIN);
}

/** Halo radius for the additive glow pass. */
export function nodeGlowRadius(width: number, strokeScale: number): number {
  return nodeDotRadius(width, strokeScale) * GLOW_GAIN;
}

/** Core opacity, clamped to the 0..1 the canvas accepts. */
export function nodeCoreAlpha(brightness: number): number {
  if (!Number.isFinite(brightness)) return NODE_CORE_ALPHA;
  return Math.min(1, Math.max(0, NODE_CORE_ALPHA * brightness));
}

/** Halo opacity, clamped the same way. */
export function nodeGlowAlpha(brightness: number): number {
  if (!Number.isFinite(brightness)) return NODE_GLOW_ALPHA;
  return Math.min(1, Math.max(0, NODE_GLOW_ALPHA * brightness));
}
