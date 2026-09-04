import { describe, expect, it } from 'vitest';
import {
  PoseCurve,
  PoseSampler,
  catmullRomTangent,
  hermite,
  interpolationLabel,
  sampleCurveChannel,
  samplePositions,
} from '../src/preview/interpolation.ts';
import { createDefaultParts, createDefaultSettings } from '../src/model/projectFactory.ts';
import { BODY_PART_ID } from '../src/model/parts.ts';
import type { AnimationProject, InterpolationMode, Pose } from '../src/model/types.ts';

function pose(id: string, time: number, positions: Record<string, [number, number]>): Pose {
  const mapped: Pose['positions'] = {};
  for (const key of Object.keys(positions)) {
    mapped[key] = { x: positions[key]![0], y: positions[key]![1] };
  }
  return { id, name: id, time, positions: mapped };
}

function project(
  poses: Pose[],
  overrides: { mode?: InterpolationMode; loop?: boolean; duration?: number; tension?: number } = {},
): AnimationProject {
  const nodeIds = [...new Set(poses.flatMap((entry) => Object.keys(entry.positions)))];
  return {
    version: 3,
    name: 'Test project',
    parts: createDefaultParts(),
    nodes: nodeIds.map((id) => ({
      id,
      name: id,
      partId: BODY_PART_ID,
      width: 1.6,
      brightness: 1,
    })),
    edges: [],
    poses,
    occluders: [],
    settings: {
      ...createDefaultSettings(),
      interpolation: overrides.mode ?? 'catmull-rom',
      loop: overrides.loop ?? true,
      duration: overrides.duration ?? 4,
      tension: overrides.tension ?? 0.5,
    },
  };
}

/** A rising-then-falling flap, so tangents and extremes actually matter. */
const flap = [
  pose('p0', 0, { n: [0, 0] }),
  pose('p1', 1, { n: [0.25, 1] }),
  pose('p2', 2, { n: [0.5, 0] }),
  pose('p3', 3, { n: [0.75, -1] }),
  pose('p4', 4, { n: [1, 0] }),
];

function sampleAt(source: AnimationProject, time: number): { x: number; y: number } {
  return samplePositions(source, time).n!;
}

describe('hermite primitives', () => {
  it('hits both endpoints exactly whatever the tangents', () => {
    expect(hermite(2, 8, 5, -3, 1, 0)).toBeCloseTo(2, 12);
    expect(hermite(2, 8, 5, -3, 1, 1)).toBeCloseTo(8, 12);
  });

  it('reduces to a straight line when both tangents match the secant', () => {
    // p1=0, p2=10 over h=2 -> secant 5 per unit time.
    expect(hermite(0, 10, 5, 5, 2, 0.5)).toBeCloseTo(5, 12);
  });

  it('scales tangents by the real time gaps, not by index', () => {
    // A value rising twice as fast on the right gets the wider secant.
    const even = catmullRomTangent(0, 1, 2, 0, 1, 2, 1);
    const uneven = catmullRomTangent(0, 1, 2, 0, 1, 1.5, 1);
    expect(even).toBeCloseTo(1, 10);
    expect(uneven).toBeGreaterThan(even);
  });

  it('flattens the tangent at a direction reversal so nothing overshoots', () => {
    // Up then down: the peak is a local extremum.
    expect(catmullRomTangent(0, 1, 0, 0, 1, 2, 1)).toBe(0);
  });

  it('scales the whole tangent by the tension value', () => {
    const full = catmullRomTangent(0, 1, 3, 0, 1, 2, 1);
    const half = catmullRomTangent(0, 1, 3, 0, 1, 2, 0.5);
    expect(half).toBeCloseTo(full * 0.5, 10);
    expect(catmullRomTangent(0, 1, 3, 0, 1, 2, 0)).toBe(0);
  });

  it('labels both modes for the inspector', () => {
    expect(interpolationLabel('linear')).toMatch(/Linear/);
    expect(interpolationLabel('catmull-rom')).toMatch(/Smooth/);
  });
});

describe('linear mode', () => {
  const linearProject = project(flap, { mode: 'linear' });

  it('returns authored values at pose times', () => {
    expect(sampleAt(linearProject, 1)).toEqual({ x: 0.25, y: 1 });
    expect(sampleAt(linearProject, 3)).toEqual({ x: 0.75, y: -1 });
  });

  it('stays strictly between the surrounding poses', () => {
    const mid = sampleAt(linearProject, 1.5);
    expect(mid.y).toBeLessThan(1);
    expect(mid.y).toBeGreaterThan(0);
  });

  it('holds the final pose past the end when not looping', () => {
    const held = project(flap, { mode: 'linear', loop: false });
    expect(sampleAt(held, 99)).toEqual({ x: 1, y: 0 });
    expect(sampleAt(held, -5)).toEqual({ x: 0, y: 0 });
  });
});

describe('catmull-rom mode', () => {
  const smooth = project(flap);

  it('passes exactly through every authored pose', () => {
    for (const authored of flap) {
      const sampled = sampleAt(smooth, authored.time);
      expect(sampled.x).toBeCloseTo(authored.positions.n!.x, 10);
      expect(sampled.y).toBeCloseTo(authored.positions.n!.y, 10);
    }
  });

  it('differs from linear between poses', () => {
    const linearProject = project(flap, { mode: 'linear' });
    const smoothMid = sampleAt(smooth, 0.5);
    const linearMid = sampleAt(linearProject, 0.5);
    expect(Math.abs(smoothMid.y - linearMid.y)).toBeGreaterThan(1e-6);
  });

  it('does not overshoot past an authored extreme', () => {
    // The peak at t=1 is y=1; nothing on the curve should exceed it.
    for (let time = 0; time <= 4; time += 0.02) {
      const value = sampleAt(smooth, time);
      expect(value.y).toBeLessThanOrEqual(1 + 1e-9);
      expect(value.y).toBeGreaterThanOrEqual(-1 - 1e-9);
    }
  });

  it('advances monotonically on a monotone channel', () => {
    let previous = -Infinity;
    for (let time = 0; time <= 4; time += 0.05) {
      const value = sampleAt(smooth, time).x;
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value;
    }
  });

  it('respects non-uniform pose times', () => {
    const uneven = project([
      pose('a', 0, { n: [0, 0] }),
      pose('b', 0.25, { n: [1, 0] }),
      pose('c', 4, { n: [2, 0] }),
    ]);
    expect(sampleAt(uneven, 0.25).x).toBeCloseTo(1, 10);
    // Most of the timeline belongs to the long second segment.
    expect(sampleAt(uneven, 2).x).toBeGreaterThan(1);
    expect(sampleAt(uneven, 2).x).toBeLessThan(2);
  });

  it('handles a two-pose project without neighbours to borrow', () => {
    const pair = project([pose('a', 0, { n: [0, 0] }), pose('b', 2, { n: [1, 1] })], {
      duration: 2,
    });
    expect(sampleAt(pair, 0)).toEqual({ x: 0, y: 0 });
    expect(sampleAt(pair, 2).x).toBeCloseTo(1, 10);
    const mid = sampleAt(pair, 1);
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(1);
  });

  it('holds a single-pose project as a static frame', () => {
    const single = project([pose('a', 0, { n: [0.3, 0.7] })]);
    expect(sampleAt(single, 0)).toEqual({ x: 0.3, y: 0.7 });
    expect(sampleAt(single, 3.5)).toEqual({ x: 0.3, y: 0.7 });
  });

  it('holds the endpoints when looping is off', () => {
    const open = project(flap, { loop: false });
    expect(sampleAt(open, 4)).toEqual({ x: 1, y: 0 });
    expect(sampleAt(open, 10)).toEqual({ x: 1, y: 0 });
    expect(sampleAt(open, -3)).toEqual({ x: 0, y: 0 });
  });
});

describe('loop boundary', () => {
  /** Wings up, down, and a Loop Close pose duplicating the first. */
  const cycle = [
    pose('up', 0, { n: [0.5, 0.1] }),
    pose('mid', 1, { n: [0.5, 0.5] }),
    pose('down', 2, { n: [0.5, 0.9] }),
    pose('recover', 3, { n: [0.5, 0.5] }),
    pose('close', 4, { n: [0.5, 0.1] }),
  ];

  it('is positionally continuous across the seam', () => {
    const looped = project(cycle, { loop: true, duration: 4 });
    const beforeSeam = sampleAt(looped, 3.999);
    const atSeam = sampleAt(looped, 4);
    const afterWrap = sampleAt(looped, 0);
    // The seam pose duplicates the first, so wrapping is a no-op positionally.
    expect(atSeam.y).toBeCloseTo(afterWrap.y, 10);
    // And the approach to it is smooth rather than a one-frame jump.
    expect(Math.abs(beforeSeam.y - atSeam.y)).toBeLessThan(0.01);
  });

  it('has no velocity snap between the last and the first segment', () => {
    const looped = project(cycle, { loop: true, duration: 4 });
    const step = 1 / 240;
    // Slope just before the seam should match the slope just after the wrap.
    const incoming = (sampleAt(looped, 4).y - sampleAt(looped, 4 - step).y) / step;
    const outgoing = (sampleAt(looped, step).y - sampleAt(looped, 0).y) / step;
    expect(incoming).toBeCloseTo(outgoing, 1);
  });

  it('wraps neighbour indices and times, stepping over a duplicated seam pose', () => {
    const curve = new PoseCurve();
    curve.sync(cycle, 4, true);
    // The pose before "up" is "recover" at t = 3 - 4 = -1, not the duplicate.
    const before = curve.neighbourBefore(0);
    expect(before.pose.id).toBe('recover');
    expect(before.time).toBeCloseTo(-1, 10);
    // The pose after "close" is "mid" at t = 1 + 4 = 5.
    const after = curve.neighbourAfter(cycle.length - 1);
    expect(after.pose.id).toBe('mid');
    expect(after.time).toBeCloseTo(5, 10);
  });

  it('clamps neighbours to the ends when looping is off', () => {
    const curve = new PoseCurve();
    curve.sync(cycle, 4, false);
    expect(curve.neighbourBefore(0).pose.id).toBe('up');
    expect(curve.neighbourAfter(cycle.length - 1).pose.id).toBe('close');
  });

  it('samples a channel through the shared curve helper', () => {
    const curve = new PoseCurve();
    curve.sync(cycle, 4, true);
    const index = curve.segmentIndexAt(1.5);
    const value = sampleCurveChannel(curve, index, 1.5, (entry) => entry.positions.n?.y, 0.5);
    expect(value).toBeGreaterThan(0.5);
    expect(value).toBeLessThan(0.9);
    // Exactly on a keyframe it returns the authored value.
    expect(sampleCurveChannel(curve, 1, 1, (entry) => entry.positions.n?.y, 0.5)).toBeCloseTo(0.5, 10);
  });
});

describe('PoseSampler in both modes', () => {
  it('matches samplePositions in smooth mode', () => {
    const smooth = project(flap);
    const sampler = new PoseSampler();
    for (const time of [0, 0.37, 1, 2.5, 3.99, 4]) {
      sampler.sample(smooth, time);
      const reference = sampleAt(smooth, time);
      expect(sampler.positions[0]).toBeCloseTo(reference.x, 5);
      expect(sampler.positions[1]).toBeCloseTo(reference.y, 5);
    }
  });

  it('matches samplePositions in linear mode', () => {
    const linearProject = project(flap, { mode: 'linear' });
    const sampler = new PoseSampler();
    for (const time of [0.2, 1.4, 3.6]) {
      sampler.sample(linearProject, time);
      const reference = sampleAt(linearProject, time);
      expect(sampler.positions[0]).toBeCloseTo(reference.x, 5);
      expect(sampler.positions[1]).toBeCloseTo(reference.y, 5);
    }
  });

  it('keeps the same buffer across frames in smooth mode', () => {
    const smooth = project(flap);
    const sampler = new PoseSampler();
    sampler.sample(smooth, 0);
    const buffer = sampler.positions;
    for (let frame = 0; frame < 120; frame += 1) {
      sampler.sample(smooth, frame / 30);
      expect(sampler.positions).toBe(buffer);
    }
    expect([...buffer].every(Number.isFinite)).toBe(true);
  });

  it('holds every node still when nothing moves between poses', () => {
    const still = project([
      pose('a', 0, { n: [0.4, 0.4], m: [0.6, 0.6] }),
      pose('b', 2, { n: [0.4, 0.4], m: [0.6, 0.6] }),
      pose('c', 4, { n: [0.4, 0.4], m: [0.6, 0.6] }),
    ]);
    for (const time of [0, 0.9, 2.2, 3.7]) {
      const sampled = samplePositions(still, time);
      expect(sampled.n).toEqual({ x: 0.4, y: 0.4 });
      expect(sampled.m).toEqual({ x: 0.6, y: 0.6 });
    }
  });
});
