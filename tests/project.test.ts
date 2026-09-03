import { beforeEach, describe, expect, it } from 'vitest';
import {
  addEdge,
  addNode,
  addPose,
  createEmptyProject,
  deleteNodes,
  deletePose,
  findEdgeBetween,
  movePose,
} from '../src/model/projectFactory.ts';
import { resetIdCounter } from '../src/utils/ids.ts';
import type { AnimationProject } from '../src/model/types.ts';

function seed(): { project: AnimationProject; a: string; b: string; c: string } {
  const project = createEmptyProject();
  const activePoseId = project.poses[0]!.id;
  const a = addNode(project, { x: 0.1, y: 0.1 }, activePoseId);
  const b = addNode(project, { x: 0.9, y: 0.1 }, activePoseId);
  const c = addNode(project, { x: 0.5, y: 0.9 }, activePoseId);
  return { project, a, b, c };
}

beforeEach(() => resetIdCounter());

describe('node creation', () => {
  it('adds the node to every pose', () => {
    const project = createEmptyProject();
    addPose(project, project.poses[0]!.id);
    addPose(project, project.poses[0]!.id);
    const id = addNode(project, { x: 0.25, y: 0.75 }, project.poses[1]!.id);

    expect(project.poses).toHaveLength(3);
    for (const pose of project.poses) {
      expect(pose.positions[id]).toEqual({ x: 0.25, y: 0.75 });
    }
  });

  it('generates unique ids rather than using indices', () => {
    const { a, b, c } = seed();
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).not.toMatch(/^\d+$/);
  });
});

describe('edge creation', () => {
  it('connects two distinct nodes', () => {
    const { project, a, b } = seed();
    const id = addEdge(project, a, b);
    expect(id).toBeTruthy();
    expect(project.edges).toHaveLength(1);
    expect(project.edges[0]!.width).toBeGreaterThan(0);
    expect(Number.isFinite(project.edges[0]!.seed)).toBe(true);
  });

  it('rejects self-edges', () => {
    const { project, a } = seed();
    expect(addEdge(project, a, a)).toBeNull();
    expect(project.edges).toHaveLength(0);
  });

  it('rejects duplicate edges in the same direction', () => {
    const { project, a, b } = seed();
    addEdge(project, a, b);
    expect(addEdge(project, a, b)).toBeNull();
    expect(project.edges).toHaveLength(1);
  });

  it('rejects duplicate edges in the reverse direction', () => {
    const { project, a, b } = seed();
    addEdge(project, a, b);
    expect(addEdge(project, b, a)).toBeNull();
    expect(project.edges).toHaveLength(1);
  });

  it('rejects edges referencing unknown nodes', () => {
    const { project, a } = seed();
    expect(addEdge(project, a, 'ghost')).toBeNull();
  });

  it('finds an existing edge in either direction', () => {
    const { project, a, b } = seed();
    addEdge(project, a, b);
    expect(findEdgeBetween(project, b, a)).toBeDefined();
    expect(findEdgeBetween(project, a, 'ghost')).toBeUndefined();
  });
});

describe('node deletion cascade', () => {
  it('removes connected edges and every pose entry', () => {
    const { project, a, b, c } = seed();
    addPose(project, project.poses[0]!.id);
    addEdge(project, a, b);
    addEdge(project, b, c);
    addEdge(project, a, c);
    expect(project.edges).toHaveLength(3);

    deleteNodes(project, [b]);

    expect(project.nodes.map((node) => node.id)).toEqual([a, c]);
    // Only the a-c edge survives.
    expect(project.edges).toHaveLength(1);
    expect(findEdgeBetween(project, a, c)).toBeDefined();
    for (const pose of project.poses) {
      expect(pose.positions[b]).toBeUndefined();
      expect(pose.positions[a]).toBeDefined();
    }
  });

  it('deletes several nodes at once', () => {
    const { project, a, b, c } = seed();
    addEdge(project, a, b);
    deleteNodes(project, [a, c]);
    expect(project.nodes.map((node) => node.id)).toEqual([b]);
    expect(project.edges).toHaveLength(0);
  });

  it('is a no-op for an empty list', () => {
    const { project } = seed();
    deleteNodes(project, []);
    expect(project.nodes).toHaveLength(3);
  });
});

describe('poses', () => {
  it('starts with a single pose named "Pose 1"', () => {
    const project = createEmptyProject();
    expect(project.poses).toHaveLength(1);
    expect(project.poses[0]!.name).toBe('Pose 1');
    expect(project.poses[0]!.time).toBe(0);
  });

  it('duplicates the source pose positions independently', () => {
    const { project, a } = seed();
    const created = addPose(project, project.poses[0]!.id);
    created.positions[a] = { x: 0.42, y: 0.42 };
    expect(project.poses[0]!.positions[a]).toEqual({ x: 0.1, y: 0.1 });
  });

  it('keeps pose times ordered and spread across the duration', () => {
    const project = createEmptyProject();
    addPose(project, project.poses[0]!.id);
    addPose(project, project.poses[1]!.id);
    const times = project.poses.map((pose) => pose.time);
    expect(times).toEqual([...times].sort((x, y) => x - y));
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBe(project.settings.duration);
  });

  it('refuses to delete the last pose', () => {
    const project = createEmptyProject();
    expect(deletePose(project, project.poses[0]!.id)).toBe(false);
    expect(project.poses).toHaveLength(1);
  });

  it('reorders poses and re-spaces their times', () => {
    const project = createEmptyProject();
    addPose(project, project.poses[0]!.id, 'Second');
    addPose(project, project.poses[1]!.id, 'Third');
    const thirdId = project.poses[2]!.id;

    expect(movePose(project, thirdId, -1)).toBe(true);
    expect(project.poses[1]!.id).toBe(thirdId);
    const times = project.poses.map((pose) => pose.time);
    expect(times).toEqual([...times].sort((x, y) => x - y));
  });

  it('will not move a pose past the ends', () => {
    const project = createEmptyProject();
    addPose(project, project.poses[0]!.id);
    expect(movePose(project, project.poses[0]!.id, -1)).toBe(false);
  });
});
