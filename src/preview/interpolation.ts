import type { AnimationProject, NodePosition, Pose } from '../model/types.ts';

/**
 * Pure interpolation layer. Deliberately free of Konva and DOM so the same code
 * can be dropped into a production site with only the raw canvas renderer.
 */

export type EasingFunction = (t: number) => number;

export function linear(t: number): number {
  return t;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpPosition(a: NodePosition, b: NodePosition, t: number): NodePosition {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

export interface PoseSegment {
  from: Pose;
  to: Pose;
  /** Local progress 0..1 between `from.time` and `to.time`. */
  t: number;
}

export function sortPosesByTime(poses: Pose[]): Pose[] {
  return [...poses].sort((a, b) => a.time - b.time);
}

/**
 * Find the two poses surrounding `time`. Times are assumed ascending (the store
 * keeps them ordered). Outside the range the nearest pose is held.
 */
export function findPoseSegment(poses: Pose[], time: number): PoseSegment {
  if (poses.length === 0) {
    throw new Error('findPoseSegment requires at least one pose');
  }
  const first = poses[0]!;
  const last = poses[poses.length - 1]!;
  if (poses.length === 1 || time <= first.time) {
    return { from: first, to: first, t: 0 };
  }
  if (time >= last.time) {
    return { from: last, to: last, t: 0 };
  }
  for (let i = 0; i < poses.length - 1; i += 1) {
    const from = poses[i]!;
    const to = poses[i + 1]!;
    if (time >= from.time && time <= to.time) {
      const span = to.time - from.time;
      const t = span <= 0 ? 0 : (time - from.time) / span;
      return { from, to, t };
    }
  }
  return { from: last, to: last, t: 0 };
}

/** Interpolate a single node id at an absolute time. */
export function sampleNodePosition(
  poses: Pose[],
  nodeId: string,
  time: number,
  easing: EasingFunction = easeInOutCubic,
): NodePosition {
  const segment = findPoseSegment(poses, time);
  const from = segment.from.positions[nodeId];
  const to = segment.to.positions[nodeId];
  if (!from && !to) return { x: 0.5, y: 0.5 };
  if (!from) return { ...to! };
  if (!to) return { ...from };
  return lerpPosition(from, to, easing(segment.t));
}

/** Interpolate every node at `time` into a plain record (editor use). */
export function samplePositions(
  project: AnimationProject,
  time: number,
  easing: EasingFunction = easeInOutCubic,
): Record<string, NodePosition> {
  const result: Record<string, NodePosition> = {};
  if (project.poses.length === 0) return result;
  const segment = findPoseSegment(project.poses, time);
  const eased = easing(segment.t);
  for (const node of project.nodes) {
    const from = segment.from.positions[node.id];
    const to = segment.to.positions[node.id];
    if (from && to) {
      result[node.id] = { x: lerp(from.x, to.x, eased), y: lerp(from.y, to.y, eased) };
    } else if (from ?? to) {
      result[node.id] = { ...(from ?? to)! };
    }
  }
  return result;
}

/**
 * Allocation-free sampler for the animation loop. The position buffer and the
 * node index map are rebuilt only when topology changes, never per frame.
 */
export class PoseSampler {
  private nodeIds: string[] = [];
  private indexById = new Map<string, number>();
  /** Interleaved [x0, y0, x1, y1, ...] in normalized space. */
  positions = new Float32Array(0);
  easing: EasingFunction = easeInOutCubic;

  syncTopology(project: AnimationProject): void {
    const changed =
      project.nodes.length !== this.nodeIds.length ||
      project.nodes.some((node, index) => this.nodeIds[index] !== node.id);
    if (!changed) return;
    this.nodeIds = project.nodes.map((node) => node.id);
    this.indexById.clear();
    this.nodeIds.forEach((id, index) => this.indexById.set(id, index));
    if (this.positions.length !== this.nodeIds.length * 2) {
      this.positions = new Float32Array(this.nodeIds.length * 2);
    }
  }

  indexOf(nodeId: string): number {
    return this.indexById.get(nodeId) ?? -1;
  }

  /** Writes into the existing buffer; allocates nothing per frame. */
  sample(project: AnimationProject, time: number): void {
    this.syncTopology(project);
    if (project.poses.length === 0) return;
    const segment = findPoseSegment(project.poses, time);
    const eased = this.easing(segment.t);
    const fromPositions = segment.from.positions;
    const toPositions = segment.to.positions;
    for (let i = 0; i < this.nodeIds.length; i += 1) {
      const id = this.nodeIds[i]!;
      const from = fromPositions[id];
      const to = toPositions[id];
      const source = from ?? to;
      if (!source) continue;
      const target = to ?? from!;
      this.positions[i * 2] = source.x + (target.x - source.x) * eased;
      this.positions[i * 2 + 1] = source.y + (target.y - source.y) * eased;
    }
  }
}

/** Wrap or clamp playback time against the project duration. */
export function advanceTime(
  time: number,
  delta: number,
  duration: number,
  loop: boolean,
): { time: number; finished: boolean } {
  let next = time + delta;
  if (duration <= 0) return { time: 0, finished: !loop };
  if (next <= duration) return { time: next, finished: false };
  if (loop) {
    next = next % duration;
    return { time: next, finished: false };
  }
  return { time: duration, finished: true };
}
