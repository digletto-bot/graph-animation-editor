import { describe, expect, it } from 'vitest';
import {
  PoseSampler,
  advanceTime,
  easeInOutCubic,
  findPoseSegment,
  lerp,
  samplePositions,
  sampleNodePosition,
} from '../src/preview/interpolation.ts';
import type { AnimationProject, Pose } from '../src/model/types.ts';
import { createDefaultParts, createDefaultSettings } from '../src/model/projectFactory.ts';
import { BODY_PART_ID } from '../src/model/parts.ts';

function pose(id: string, time: number, positions: Record<string, [number, number]>): Pose {
  const mapped: Pose['positions'] = {};
  for (const key of Object.keys(positions)) {
    mapped[key] = { x: positions[key]![0], y: positions[key]![1] };
  }
  return { id, name: id, time, positions: mapped };
}

const poses = [
  pose('a', 0, { n1: [0, 0], n2: [1, 1] }),
  pose('b', 1, { n1: [1, 0], n2: [0, 1] }),
  pose('c', 2, { n1: [1, 1], n2: [0, 0] }),
];

describe('linear interpolation', () => {
  it('interpolates endpoints exactly', () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
    expect(lerp(10, 20, 0.5)).toBe(15);
  });

  it('handles negative and descending ranges', () => {
    expect(lerp(20, -20, 0.25)).toBe(10);
  });
});

describe('easeInOutCubic', () => {
  it('pins the endpoints and the midpoint', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
  });

  it('is slower than linear at the start and symmetric', () => {
    expect(easeInOutCubic(0.25)).toBeLessThan(0.25);
    expect(easeInOutCubic(0.75)).toBeGreaterThan(0.75);
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 10);
  });

  it('is monotonic', () => {
    let previous = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const value = easeInOutCubic(Math.min(1, t));
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

describe('pose segment selection', () => {
  it('picks the surrounding pair and local progress', () => {
    const segment = findPoseSegment(poses, 0.25);
    expect(segment.from.id).toBe('a');
    expect(segment.to.id).toBe('b');
    expect(segment.t).toBeCloseTo(0.25, 10);
  });

  it('picks the second segment past the middle pose', () => {
    const segment = findPoseSegment(poses, 1.75);
    expect(segment.from.id).toBe('b');
    expect(segment.to.id).toBe('c');
    expect(segment.t).toBeCloseTo(0.75, 10);
  });

  it('holds the first pose before the range', () => {
    const segment = findPoseSegment(poses, -5);
    expect(segment.from.id).toBe('a');
    expect(segment.to.id).toBe('a');
    expect(segment.t).toBe(0);
  });

  it('holds the last pose past the range', () => {
    const segment = findPoseSegment(poses, 99);
    expect(segment.from.id).toBe('c');
    expect(segment.to.id).toBe('c');
  });

  it('treats a single pose as a static frame', () => {
    const segment = findPoseSegment([poses[0]!], 12);
    expect(segment.from.id).toBe('a');
    expect(segment.to.id).toBe('a');
    expect(segment.t).toBe(0);
  });

  it('handles zero-length segments without dividing by zero', () => {
    const duplicated = [pose('x', 1, { n1: [0, 0] }), pose('y', 1, { n1: [1, 1] })];
    const segment = findPoseSegment(duplicated, 1);
    expect(Number.isFinite(segment.t)).toBe(true);
  });

  it('throws when there are no poses at all', () => {
    expect(() => findPoseSegment([], 0)).toThrow();
  });
});

describe('eased sampling', () => {
  const project: AnimationProject = {
    version: 3,
    parts: createDefaultParts(),
    nodes: [
      { id: 'n1', name: 'n1', partId: BODY_PART_ID, width: 1.6, brightness: 1 },
      { id: 'n2', name: 'n2', partId: BODY_PART_ID, width: 1.6, brightness: 1 },
    ],
    edges: [],
    poses,
    occluders: [],
    // These cases predate the smooth mode and assert the eased linear path.
    settings: { ...createDefaultSettings(), interpolation: 'linear' },
  };

  it('applies easing rather than raw linear progress', () => {
    const eased = sampleNodePosition(poses, 'n1', 0.25);
    expect(eased.x).toBeCloseTo(easeInOutCubic(0.25), 10);
    expect(eased.x).not.toBeCloseTo(0.25, 3);
  });

  it('returns exact pose values at pose times', () => {
    const atPose = samplePositions(project, 1);
    expect(atPose.n1).toEqual({ x: 1, y: 0 });
    expect(atPose.n2).toEqual({ x: 0, y: 1 });
  });

  it('samples every node in the project', () => {
    const result = samplePositions(project, 0.5);
    expect(Object.keys(result).sort()).toEqual(['n1', 'n2']);
  });

  it('fills a reusable buffer without reallocating', () => {
    const sampler = new PoseSampler();
    sampler.sample(project, 0.5);
    const buffer = sampler.positions;
    expect(buffer.length).toBe(4);
    sampler.sample(project, 0.9);
    // Same underlying Float32Array instance across frames.
    expect(sampler.positions).toBe(buffer);
    expect(sampler.indexOf('n2')).toBe(1);
    expect(sampler.indexOf('missing')).toBe(-1);
  });

  it('matches samplePositions output', () => {
    const sampler = new PoseSampler();
    sampler.sample(project, 0.42);
    const reference = samplePositions(project, 0.42);
    expect(sampler.positions[0]).toBeCloseTo(reference.n1!.x, 5);
    expect(sampler.positions[3]).toBeCloseTo(reference.n2!.y, 5);
  });
});

describe('advanceTime', () => {
  it('wraps when looping', () => {
    expect(advanceTime(3.9, 0.2, 4, true).time).toBeCloseTo(0.1, 6);
  });

  it('stops at the end when not looping', () => {
    const result = advanceTime(3.9, 0.5, 4, false);
    expect(result.time).toBe(4);
    expect(result.finished).toBe(true);
  });

  it('advances normally mid-range', () => {
    expect(advanceTime(1, 0.5, 4, true).time).toBeCloseTo(1.5, 6);
  });
});
