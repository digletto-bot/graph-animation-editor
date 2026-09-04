/**
 * The runtime's public surface: everything needed to play an animation project
 * on a canvas, and nothing that belongs to the editor.
 *
 * Nothing in this folder may import from outside it — `tests/runtimeBoundary`
 * enforces that — so this file is what the published `line-bird` package
 * exposes. Two things are deliberately kept out of it and live at their own
 * entry points: `line-bird/validate`, so an app that trusts its own documents
 * does not ship the schema checks, and `line-bird/element`, because importing a
 * player should not register a custom element as a side effect.
 */

export { AnimationPlayer, type TimeListener } from './AnimationPlayer.ts';
export { mount, type MountOptions } from './mount.ts';
export { PoseSampler, advanceTime, findPoseSegment, sortPosesByTime } from './interpolation.ts';
export { renderablePartsInOrder, sortPartsByZ } from './parts.ts';
export { OccluderResolver } from './occluders.ts';
export {
  DEFAULT_EDGE_BRIGHTNESS,
  DEFAULT_EDGE_WIDTH,
  DEFAULT_NODE_BRIGHTNESS,
  DEFAULT_NODE_WIDTH,
  createDefaultSettings,
} from './defaults.ts';
export type {
  AnimationProject,
  GraphEdge,
  GraphNode,
  GraphPart,
  InterpolationMode,
  NodePosition,
  OccluderPath,
  Pose,
  ProjectSettings,
  Size,
} from './types.ts';
