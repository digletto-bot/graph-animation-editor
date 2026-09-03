import type { AnimationProject, InterpolationMode, NodePosition, Pose } from '../model/types.ts';

/**
 * Pure interpolation layer. Deliberately free of Konva and DOM so the same code
 * can be dropped into a production site with only the raw canvas renderer.
 *
 * Two modes:
 *
 *  - `linear`       lerp between the surrounding poses through an easing curve.
 *  - `catmull-rom`  time-aware cubic Hermite whose tangents come from the
 *                   neighbouring poses (Catmull-Rom style). Non-uniform pose
 *                   times are respected, and looping wraps the neighbours.
 *
 * The scalar helpers at the bottom (`hermite`, `catmullRomTangent`,
 * `PoseCurve`) know nothing about nodes, so Phase 2 can drive rig-control
 * channels through exactly the same maths.
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

/* ------------------------------------------------------------------ */
/* Scalar curve maths — channel agnostic, reusable by any rig value.    */
/* ------------------------------------------------------------------ */

/**
 * Cubic Hermite on one scalar channel.
 *
 * `m1`/`m2` are tangents *per unit time*; `h` is the segment duration, so a
 * short segment does not inherit a wildly steep slope from a long neighbour.
 */
export function hermite(
  p1: number,
  p2: number,
  m1: number,
  m2: number,
  h: number,
  s: number,
): number {
  const s2 = s * s;
  const s3 = s2 * s;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  // Written as p1 + h01*(p2 - p1) rather than h00*p1 + h01*p2: algebraically
  // identical, but exact when p1 === p2, so a node that never moves between
  // two poses reports its authored value bit for bit instead of drifting.
  return p1 + h01 * (p2 - p1) + h * (h10 * m1 + h11 * m2);
}

/**
 * Catmull-Rom tangent at `p1`, from its neighbours and their *actual* times.
 *
 * `tension` 0..1 scales the whole tangent: 1 is a full Catmull-Rom curve, 0
 * flattens every pose into a hold (a smooth ease through the keyframe with no
 * overshoot at all). Reversals are clamped to zero and the magnitude is capped
 * against the adjacent secants, which keeps a wing from swinging past the pose
 * the animator authored while staying C1 continuous.
 */
export function catmullRomTangent(
  p0: number,
  p1: number,
  p2: number,
  t0: number,
  t1: number,
  t2: number,
  tension: number,
): number {
  const spanBefore = t1 - t0;
  const spanAfter = t2 - t1;
  const secantBefore = spanBefore > 0 ? (p1 - p0) / spanBefore : 0;
  const secantAfter = spanAfter > 0 ? (p2 - p1) / spanAfter : 0;

  // Local extremum: hold the authored value instead of overshooting past it.
  if (secantBefore === 0 || secantAfter === 0 || secantBefore * secantAfter < 0) return 0;

  const total = spanBefore + spanAfter;
  const tangent = total > 0 ? (p2 - p0) / total : 0;

  // Monotone cap (Fritsch-Carlson): never steeper than 3x the flatter secant.
  const limit = 3 * Math.min(Math.abs(secantBefore), Math.abs(secantAfter));
  const capped = Math.sign(tangent) * Math.min(Math.abs(tangent), limit);
  return capped * tension;
}

/**
 * Cyclic-aware neighbour lookup over a pose list.
 *
 * Built once per topology/timing change and reused for every node and every
 * frame, so sampling never rebuilds index maths inside the animation loop.
 */
export class PoseCurve {
  /** Poses in time order; the same objects the project holds. */
  poses: Pose[] = [];
  /** Index of the pose before each pose (cyclic when looping). */
  private beforeIndex = new Int32Array(0);
  /** Index of the pose after each pose (cyclic when looping). */
  private afterIndex = new Int32Array(0);
  /** Effective time of that earlier neighbour (may be negative when wrapped). */
  private beforeTime = new Float64Array(0);
  /** Effective time of that later neighbour (may exceed the duration). */
  private afterTime = new Float64Array(0);
  private key = '';

  /** Cheap rebuild guard: pose identity, timing, loop flag and duration. */
  sync(poses: Pose[], duration: number, loop: boolean): void {
    const key = `${loop ? 1 : 0}:${duration}:${poses.map((pose) => `${pose.id}@${pose.time}`).join(',')}`;
    if (key === this.key) return;
    this.key = key;
    this.poses = poses;

    const count = poses.length;
    if (this.beforeIndex.length !== count) {
      this.beforeIndex = new Int32Array(count);
      this.afterIndex = new Int32Array(count);
      this.beforeTime = new Float64Array(count);
      this.afterTime = new Float64Array(count);
    }
    if (count === 0) return;

    const last = poses[count - 1]!;
    // A "Loop Close" pose duplicating the first one at the end of the cycle is
    // the same cyclic keyframe, so wrapping has to step over it.
    const seamDuplicated = loop && count > 2 && last.time >= duration - 1e-6;

    for (let i = 0; i < count; i += 1) {
      if (i > 0) {
        this.beforeIndex[i] = i - 1;
        this.beforeTime[i] = poses[i - 1]!.time;
      } else if (loop && count > 1) {
        const index = seamDuplicated ? count - 2 : count - 1;
        this.beforeIndex[i] = index;
        this.beforeTime[i] = poses[index]!.time - duration;
      } else {
        this.beforeIndex[i] = i;
        this.beforeTime[i] = poses[i]!.time;
      }

      if (i < count - 1) {
        this.afterIndex[i] = i + 1;
        this.afterTime[i] = poses[i + 1]!.time;
      } else if (loop && count > 1) {
        const index = seamDuplicated ? 1 : 0;
        this.afterIndex[i] = index;
        this.afterTime[i] = poses[index]!.time + duration;
      } else {
        this.afterIndex[i] = i;
        this.afterTime[i] = poses[i]!.time;
      }
    }
  }

  /** Pose used as `p0` for the segment starting at `index`, and its time. */
  neighbourBefore(index: number): { pose: Pose; time: number } {
    const at = this.beforeIndex[index] ?? index;
    return { pose: this.poses[at]!, time: this.beforeTime[index] ?? this.poses[index]!.time };
  }

  /** Pose used as `p3` for the segment ending at `index`, and its time. */
  neighbourAfter(index: number): { pose: Pose; time: number } {
    const at = this.afterIndex[index] ?? index;
    return { pose: this.poses[at]!, time: this.afterTime[index] ?? this.poses[index]!.time };
  }

  /** Index of the pose at or before `time`, clamped into range. */
  segmentIndexAt(time: number): number {
    const count = this.poses.length;
    if (count === 0) return -1;
    if (time <= this.poses[0]!.time) return 0;
    for (let i = count - 1; i >= 0; i -= 1) {
      if (time >= this.poses[i]!.time) return i;
    }
    return 0;
  }
}

export interface SmoothOptions {
  duration: number;
  loop: boolean;
  tension: number;
}

/**
 * Evaluate one scalar channel of one pose segment with Catmull-Rom tangents.
 * `readValue` pulls the channel out of a pose, which is what keeps this usable
 * for node positions today and rig controls later.
 */
export function sampleCurveChannel(
  curve: PoseCurve,
  index: number,
  time: number,
  readValue: (pose: Pose) => number | undefined,
  tension: number,
): number | undefined {
  const poses = curve.poses;
  const p1Pose = poses[index];
  if (!p1Pose) return undefined;
  const p2Pose = poses[index + 1];
  const p1 = readValue(p1Pose);
  if (p1 === undefined) return undefined;
  if (!p2Pose) return p1;

  const p2 = readValue(p2Pose);
  if (p2 === undefined) return p1;

  const t1 = p1Pose.time;
  const t2 = p2Pose.time;
  const span = t2 - t1;
  if (span <= 0) return p2;
  const s = Math.min(1, Math.max(0, (time - t1) / span));

  const before = curve.neighbourBefore(index);
  const after = curve.neighbourAfter(index + 1);
  const p0 = readValue(before.pose) ?? p1;
  const p3 = readValue(after.pose) ?? p2;

  const m1 = catmullRomTangent(p0, p1, p2, before.time, t1, t2, tension);
  const m2 = catmullRomTangent(p1, p2, p3, t1, t2, after.time, tension);
  return hermite(p1, p2, m1, m2, span, s);
}

/* ------------------------------------------------------------------ */
/* Node sampling                                                       */
/* ------------------------------------------------------------------ */

/** Interpolate a single node id at an absolute time (linear/eased path). */
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

const sharedCurve = new PoseCurve();

function smoothOptionsFor(project: AnimationProject): SmoothOptions {
  return {
    duration: project.settings.duration,
    loop: project.settings.loop,
    tension: project.settings.tension,
  };
}

/**
 * Interpolate every node at `time` into a plain record (editor use).
 * Honours the project's interpolation mode.
 */
export function samplePositions(
  project: AnimationProject,
  time: number,
  easing: EasingFunction = easeInOutCubic,
): Record<string, NodePosition> {
  const result: Record<string, NodePosition> = {};
  if (project.poses.length === 0) return result;

  if (project.settings.interpolation === 'catmull-rom' && project.poses.length > 1) {
    const options = smoothOptionsFor(project);
    sharedCurve.sync(project.poses, options.duration, options.loop);
    const index = sharedCurve.segmentIndexAt(time);
    for (const node of project.nodes) {
      const x = sampleCurveChannel(
        sharedCurve,
        index,
        time,
        (pose) => pose.positions[node.id]?.x,
        options.tension,
      );
      const y = sampleCurveChannel(
        sharedCurve,
        index,
        time,
        (pose) => pose.positions[node.id]?.y,
        options.tension,
      );
      if (x !== undefined && y !== undefined) result[node.id] = { x, y };
    }
    return result;
  }

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
 * Allocation-free sampler for the animation loop. The position buffer, the node
 * index map and the pose-neighbour cache are rebuilt only when topology or
 * timing changes, never per frame.
 */
export class PoseSampler {
  private nodeIds: string[] = [];
  private indexById = new Map<string, number>();
  /** Interleaved [x0, y0, x1, y1, ...] in normalized space. */
  positions = new Float32Array(0);
  easing: EasingFunction = easeInOutCubic;
  private curve = new PoseCurve();

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

    if (project.settings.interpolation === 'catmull-rom' && project.poses.length > 1) {
      this.sampleSmooth(project, time);
      return;
    }

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

  private sampleSmooth(project: AnimationProject, time: number): void {
    const settings = project.settings;
    this.curve.sync(project.poses, settings.duration, settings.loop);
    const index = this.curve.segmentIndexAt(time);
    const poses = this.curve.poses;
    const p1Pose = poses[index];
    if (!p1Pose) return;
    const p2Pose = poses[index + 1];

    if (!p2Pose) {
      // Past the final pose: hold it, exactly like the linear path does.
      for (let i = 0; i < this.nodeIds.length; i += 1) {
        const position = p1Pose.positions[this.nodeIds[i]!];
        if (!position) continue;
        this.positions[i * 2] = position.x;
        this.positions[i * 2 + 1] = position.y;
      }
      return;
    }

    const t1 = p1Pose.time;
    const t2 = p2Pose.time;
    const span = t2 - t1;
    const s = span <= 0 ? 1 : Math.min(1, Math.max(0, (time - t1) / span));
    const before = this.curve.neighbourBefore(index);
    const after = this.curve.neighbourAfter(index + 1);
    const tension = settings.tension;

    for (let i = 0; i < this.nodeIds.length; i += 1) {
      const id = this.nodeIds[i]!;
      const p1 = p1Pose.positions[id];
      const p2 = p2Pose.positions[id];
      if (!p1) continue;
      if (!p2 || span <= 0) {
        const held = p2 ?? p1;
        this.positions[i * 2] = held.x;
        this.positions[i * 2 + 1] = held.y;
        continue;
      }
      const p0 = before.pose.positions[id] ?? p1;
      const p3 = after.pose.positions[id] ?? p2;

      const mx1 = catmullRomTangent(p0.x, p1.x, p2.x, before.time, t1, t2, tension);
      const mx2 = catmullRomTangent(p1.x, p2.x, p3.x, t1, t2, after.time, tension);
      const my1 = catmullRomTangent(p0.y, p1.y, p2.y, before.time, t1, t2, tension);
      const my2 = catmullRomTangent(p1.y, p2.y, p3.y, t1, t2, after.time, tension);

      this.positions[i * 2] = hermite(p1.x, p2.x, mx1, mx2, span, s);
      this.positions[i * 2 + 1] = hermite(p1.y, p2.y, my1, my2, span, s);
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

/** Mode label for UI copy; keeps the strings in one place. */
export function interpolationLabel(mode: InterpolationMode): string {
  return mode === 'catmull-rom' ? 'Smooth (Catmull-Rom)' : 'Linear (eased)';
}
