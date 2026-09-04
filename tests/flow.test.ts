import { describe, expect, it } from 'vitest';
import { EditorStore } from '../src/state/EditorStore.ts';
import { parseProject, serializeProject } from '../src/model/serialization.ts';
import { PoseSampler, samplePositions } from '../src/runtime/interpolation.ts';

/**
 * End-to-end at the data level: trace a shape, build a second pose, scrub the
 * timeline, then export and re-import. This is the path a user actually walks.
 */
function traceShape() {
  const store = new EditorStore();
  const ids = [
    store.addNodeAt({ x: 0.2, y: 0.5 }),
    store.addNodeAt({ x: 0.5, y: 0.2 }),
    store.addNodeAt({ x: 0.8, y: 0.5 }),
    store.addNodeAt({ x: 0.5, y: 0.8 }),
  ];
  store.addEdgeBetween(ids[0]!, ids[1]!);
  store.addEdgeBetween(ids[1]!, ids[2]!);
  store.addEdgeBetween(ids[2]!, ids[3]!);
  store.addEdgeBetween(ids[3]!, ids[0]!);
  return { store, ids };
}

describe('authoring flow', () => {
  it('builds a connected graph from clicks', () => {
    const { store } = traceShape();
    expect(store.state.project.nodes).toHaveLength(4);
    expect(store.state.project.edges).toHaveLength(4);
    // Every edge references real nodes.
    const nodeIds = new Set(store.state.project.nodes.map((node) => node.id));
    for (const edge of store.state.project.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
  });

  it('animates between two poses without disturbing the first', () => {
    const { store, ids } = traceShape();
    const restId = store.state.activePoseId;

    store.duplicateActivePose();
    const liftId = store.state.activePoseId;

    // Raise the top node in the second pose only.
    store.beginTransaction('Move nodes');
    store.setNodePositions({ [ids[1]!]: { x: 0.5, y: 0.05 } });
    store.endTransaction();

    const rest = store.state.project.poses.find((pose) => pose.id === restId)!;
    const lift = store.state.project.poses.find((pose) => pose.id === liftId)!;
    expect(rest.positions[ids[1]!]).toEqual({ x: 0.5, y: 0.2 });
    expect(lift.positions[ids[1]!]).toEqual({ x: 0.5, y: 0.05 });

    // Midway through, the node sits strictly between the two poses.
    const midTime = (rest.time + lift.time) / 2;
    const mid = samplePositions(store.state.project, midTime);
    expect(mid[ids[1]!]!.y).toBeGreaterThan(0.05);
    expect(mid[ids[1]!]!.y).toBeLessThan(0.2);

    // Unmoved nodes stay put across the whole timeline.
    expect(mid[ids[0]!]).toEqual({ x: 0.2, y: 0.5 });
  });

  it('scrubbing switches the stage to interpolated positions', () => {
    const { store } = traceShape();
    store.duplicateActivePose();
    expect(store.isPreviewingTimeline).toBe(false);
    store.setScrubbing(true);
    expect(store.isPreviewingTimeline).toBe(true);
    store.setScrubbing(false);
    store.setPlaying(true);
    expect(store.isPreviewingTimeline).toBe(true);
  });

  it('survives an export and import round trip unchanged', () => {
    const { store, ids } = traceShape();
    store.duplicateActivePose();
    store.beginTransaction('Move nodes');
    store.setNodePositions({ [ids[1]!]: { x: 0.5, y: 0.05 } });
    store.endTransaction();

    const before = store.state.project;
    const result = parseProject(serializeProject(before));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const restored = new EditorStore(result.project);
    expect(restored.state.project.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
    expect(restored.state.project.edges.map((e) => `${e.from}>${e.to}`)).toEqual(
      before.edges.map((e) => `${e.from}>${e.to}`),
    );
    // Same animation: sampling both projects at the same time agrees.
    for (const time of [0, 0.7, 1.9, 4]) {
      expect(samplePositions(restored.state.project, time)).toEqual(samplePositions(before, time));
    }
  });

  it('keeps the sampler buffer stable across many frames', () => {
    const { store } = traceShape();
    store.duplicateActivePose();
    const sampler = new PoseSampler();
    sampler.sample(store.state.project, 0);
    const buffer = sampler.positions;
    for (let frame = 0; frame < 120; frame += 1) {
      sampler.sample(store.state.project, frame / 30);
      expect(sampler.positions).toBe(buffer);
    }
    expect([...buffer].every(Number.isFinite)).toBe(true);
  });

  it('handles a single-pose project as a static frame', () => {
    const { store, ids } = traceShape();
    expect(store.state.project.poses).toHaveLength(1);
    const early = samplePositions(store.state.project, 0);
    const late = samplePositions(store.state.project, 3.9);
    expect(early).toEqual(late);
    expect(early[ids[0]!]).toEqual({ x: 0.2, y: 0.5 });
  });
});

describe('scale', () => {
  it('handles the target size of 200 nodes, 500 edges and 10 poses', () => {
    const store = new EditorStore();
    const ids: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      ids.push(store.addNodeAt({ x: (i % 20) / 20, y: Math.floor(i / 20) / 10 }));
    }
    let edges = 0;
    for (let i = 0; i < 200 && edges < 500; i += 1) {
      for (let step = 1; step <= 3 && edges < 500; step += 1) {
        const target = (i + step) % 200;
        if (store.addEdgeBetween(ids[i]!, ids[target]!)) edges += 1;
      }
    }
    for (let i = 0; i < 9; i += 1) store.addPoseAfterActive();

    expect(store.state.project.nodes).toHaveLength(200);
    expect(store.state.project.edges.length).toBeGreaterThanOrEqual(500);
    expect(store.state.project.poses).toHaveLength(10);
    // Every pose carries a position for every node.
    for (const pose of store.state.project.poses) {
      expect(Object.keys(pose.positions)).toHaveLength(200);
    }

    const sampler = new PoseSampler();
    const start = performance.now();
    for (let frame = 0; frame < 60; frame += 1) sampler.sample(store.state.project, frame / 30);
    const elapsed = performance.now() - start;
    // 60 frames of interpolation should be far under one frame budget.
    expect(elapsed).toBeLessThan(200);
  });
});
