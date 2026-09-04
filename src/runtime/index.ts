/**
 * The runtime's public surface: everything needed to play an animation project
 * on a canvas, and nothing that belongs to the editor.
 *
 * Nothing in this folder may import from outside it — `tests/runtimeBoundary`
 * enforces that — so this file is also what a published player package would
 * expose. Loading a `.json` file is the embedder's business until the
 * validation path is split out for it.
 */

export { AnimationPlayer, type TimeListener } from './AnimationPlayer.ts';
export { PoseSampler, advanceTime, findPoseSegment, sortPosesByTime } from './interpolation.ts';
export { renderablePartsInOrder, sortPartsByZ } from './parts.ts';
export { OccluderResolver } from './occluders.ts';
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
