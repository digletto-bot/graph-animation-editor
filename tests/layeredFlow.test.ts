import { describe, expect, it } from 'vitest';
import { EditorStore } from '../src/state/EditorStore.ts';
import { parseProject, serializeProject } from '../src/model/serialization.ts';
import { PoseSampler, samplePositions } from '../src/preview/interpolation.ts';
import { OccluderResolver, resolveOccluderPolygon } from '../src/model/occluders.ts';
import {
  BODY_PART_ID,
  FAR_WING_PART_ID,
  NEAR_WING_PART_ID,
  renderablePartsInOrder,
} from '../src/model/parts.ts';

/**
 * The layered path a user actually walks: trace a body and two wings into
 * separate parts, draw a body silhouette that masks the far wing, scaffold a
 * flap cycle, then scrub, export and re-import.
 */
function traceBird() {
  const store = new EditorStore();

  store.setActivePart(FAR_WING_PART_ID);
  const far = [
    store.addNodeAt({ x: 0.30, y: 0.45 }),
    store.addNodeAt({ x: 0.18, y: 0.30 }),
    store.addNodeAt({ x: 0.10, y: 0.42 }),
  ];
  store.addEdgeBetween(far[0]!, far[1]!);
  store.addEdgeBetween(far[1]!, far[2]!);

  store.setActivePart(BODY_PART_ID);
  const body = [
    store.addNodeAt({ x: 0.42, y: 0.35 }),
    store.addNodeAt({ x: 0.62, y: 0.38 }),
    store.addNodeAt({ x: 0.58, y: 0.62 }),
    store.addNodeAt({ x: 0.40, y: 0.58 }),
  ];
  for (let i = 0; i < body.length; i += 1) {
    store.addEdgeBetween(body[i]!, body[(i + 1) % body.length]!);
  }

  store.setActivePart(NEAR_WING_PART_ID);
  const near = [
    store.addNodeAt({ x: 0.60, y: 0.45 }),
    store.addNodeAt({ x: 0.78, y: 0.30 }),
    store.addNodeAt({ x: 0.88, y: 0.44 }),
  ];
  store.addEdgeBetween(near[0]!, near[1]!);
  store.addEdgeBetween(near[1]!, near[2]!);

  return { store, far, body, near };
}

/**
 * Ten poses across the cycle, each a copy of the active one — the multi-pose
 * fixture these flows need. Adding a pose already re-spaces the timeline, so
 * the explicit distribute call only pins the intent.
 */
function addPoses(store: EditorStore, total = 10): void {
  while (store.state.project.poses.length < total) store.addPoseAfterActive();
  store.distributePoseTimes();
  store.setActivePose(store.state.project.poses[0]!.id);
}

describe('layered authoring flow', () => {
  it('keeps three parts with their own geometry, back to front', () => {
    const { store } = traceBird();
    const project = store.state.project;
    expect(renderablePartsInOrder(project).map((part) => part.role)).toEqual([
      'far-wing',
      'body',
      'near-wing',
    ]);
    const countIn = (partId: string) =>
      project.nodes.filter((node) => node.partId === partId).length;
    expect(countIn(FAR_WING_PART_ID)).toBe(3);
    expect(countIn(BODY_PART_ID)).toBe(4);
    expect(countIn(NEAR_WING_PART_ID)).toBe(3);
  });

  it('masks the far wing from the body and near-wing silhouettes', () => {
    const { store, body, near } = traceBird();
    store.setActivePart(BODY_PART_ID);
    store.addOccluder(body, {
      name: 'Body silhouette',
      ownerPartId: BODY_PART_ID,
      targetPartIds: [FAR_WING_PART_ID],
    });
    store.setActivePart(NEAR_WING_PART_ID);
    store.addOccluder(near, {
      name: 'Near wing silhouette',
      ownerPartId: NEAR_WING_PART_ID,
      targetPartIds: [FAR_WING_PART_ID],
    });

    const sampler = new PoseSampler();
    sampler.sample(store.state.project, 0);
    const resolver = new OccluderResolver();
    resolver.sync(store.state.project, (nodeId) => sampler.indexOf(nodeId));

    expect(resolver.forTarget(FAR_WING_PART_ID)).toHaveLength(2);
    expect(resolver.forTarget(BODY_PART_ID)).toHaveLength(0);
    expect(resolver.forTarget(NEAR_WING_PART_ID)).toHaveLength(0);
  });

  it('keeps the far wing fully structured while it is hidden and x-rayed', () => {
    const { store, far } = traceBird();
    store.updatePartDisplay(FAR_WING_PART_ID, { hidden: true, xray: true });

    // Editor display state only: the geometry is all still there.
    const project = store.state.project;
    expect(project.nodes.filter((node) => node.partId === FAR_WING_PART_ID)).toHaveLength(3);
    expect(project.edges.filter((edge) => edge.partId === FAR_WING_PART_ID)).toHaveLength(2);
    for (const id of far) expect(store.nodeById(id)).toBeDefined();
    // And it still renders in production.
    expect(renderablePartsInOrder(project).map((part) => part.id)).toContain(FAR_WING_PART_ID);
  });

  it('moves occluder vertices with the poses they reference', () => {
    const { store, body } = traceBird();
    const occluderId = store.addOccluder(body, { ownerPartId: BODY_PART_ID })!;
    store.updateSettings({ interpolation: 'linear' });

    store.duplicateActivePose();
    store.beginTransaction('Move nodes');
    store.setNodePositions({ [body[0]!]: { x: 0.5, y: 0.2 } });
    store.endTransaction();

    const project = store.state.project;
    const occluder = project.occluders.find((entry) => entry.id === occluderId)!;
    const first = resolveOccluderPolygon(occluder, project.poses[0]!.positions)!;
    const second = resolveOccluderPolygon(occluder, project.poses[1]!.positions)!;
    expect(first[0]).toEqual({ x: 0.42, y: 0.35 });
    expect(second[0]).toEqual({ x: 0.5, y: 0.2 });

    // Halfway between the poses the vertex is halfway too.
    const midTime = (project.poses[0]!.time + project.poses[1]!.time) / 2;
    const mid = resolveOccluderPolygon(occluder, samplePositions(project, midTime))!;
    expect(mid[0]!.y).toBeLessThan(0.35);
    expect(mid[0]!.y).toBeGreaterThan(0.2);
  });

  it('scaffolds a flap cycle that every part shares', () => {
    const { store, far, body, near } = traceBird();
    addPoses(store);

    const project = store.state.project;
    expect(project.poses).toHaveLength(10);
    for (const pose of project.poses) {
      // Every node of every part is posed, hidden wing included.
      expect(Object.keys(pose.positions)).toHaveLength(10);
      for (const id of [...far, ...body, ...near]) {
        expect(pose.positions[id]).toBeDefined();
      }
    }
  });

  it('scrubs interpolated frames in both modes without disturbing the poses', () => {
    const { store, body } = traceBird();
    addPoses(store);
    const poses = store.state.project.poses;
    store.setActivePose(poses[2]!.id);
    store.beginTransaction('Move nodes');
    store.setNodePositions({ [body[0]!]: { x: 0.5, y: 0.15 } });
    store.endTransaction();

    const authored = { ...store.state.project.poses[2]!.positions[body[0]!]! };

    for (const mode of ['linear', 'catmull-rom'] as const) {
      store.updateSettings({ interpolation: mode });
      store.setScrubbing(true);
      store.setPlaybackTime(store.state.project.poses[2]!.time);
      const atPose = samplePositions(store.state.project, store.state.project.poses[2]!.time);
      // Scrubbing exactly onto a pose returns the authored values.
      expect(atPose[body[0]!]!.x).toBeCloseTo(authored.x, 6);
      expect(atPose[body[0]!]!.y).toBeCloseTo(authored.y, 6);
      store.setScrubbing(false);
      // And the stored pose was never touched by the scrub.
      expect(store.state.project.poses[2]!.positions[body[0]!]).toEqual(authored);
    }
  });

  it('round trips the whole layered project through JSON', () => {
    const { store, body, near } = traceBird();
    store.addOccluder(body, {
      name: 'Body silhouette',
      ownerPartId: BODY_PART_ID,
      targetPartIds: [FAR_WING_PART_ID],
    });
    store.addOccluder(near, {
      name: 'Near wing silhouette',
      ownerPartId: NEAR_WING_PART_ID,
      targetPartIds: [FAR_WING_PART_ID],
    });
    addPoses(store);
    store.setPartRenderEnabled(NEAR_WING_PART_ID, false);

    const before = store.state.project;
    const result = parseProject(serializeProject(before));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const restored = new EditorStore(result.project);
    expect(restored.state.project.parts).toEqual(before.parts);
    expect(restored.state.project.occluders).toEqual(before.occluders);
    expect(restored.state.project.nodes).toEqual(before.nodes);
    expect(restored.state.project.edges).toEqual(before.edges);
    expect(restored.state.project.poses).toHaveLength(10);
    expect(restored.partById(NEAR_WING_PART_ID)!.renderEnabled).toBe(false);

    // Same animation on both sides of the trip.
    for (const time of [0, 0.7, 1.9, 4]) {
      expect(samplePositions(restored.state.project, time)).toEqual(samplePositions(before, time));
    }
  });

  it('still handles the target scale with parts and occluders in play', () => {
    const store = new EditorStore();
    const partIds = [FAR_WING_PART_ID, BODY_PART_ID, NEAR_WING_PART_ID];
    const ids: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      store.setActivePart(partIds[i % 3]!);
      ids.push(store.addNodeAt({ x: (i % 20) / 20, y: Math.floor(i / 20) / 10 }));
    }
    let edges = 0;
    for (let i = 0; i < 200 && edges < 500; i += 1) {
      store.setActivePart(partIds[i % 3]!);
      for (let step = 1; step <= 3 && edges < 500; step += 1) {
        if (store.addEdgeBetween(ids[i]!, ids[(i + step) % 200]!)) edges += 1;
      }
    }
    for (let i = 0; i < 4; i += 1) {
      store.addOccluder([ids[i]!, ids[i + 20]!, ids[i + 40]!, ids[i + 60]!], {
        ownerPartId: BODY_PART_ID,
        targetPartIds: [FAR_WING_PART_ID],
      });
    }
    addPoses(store);

    expect(store.state.project.nodes).toHaveLength(200);
    expect(store.state.project.edges.length).toBeGreaterThanOrEqual(500);
    expect(store.state.project.poses).toHaveLength(10);
    expect(store.state.project.occluders).toHaveLength(4);

    const sampler = new PoseSampler();
    const resolver = new OccluderResolver();
    const start = performance.now();
    for (let frame = 0; frame < 60; frame += 1) {
      sampler.sample(store.state.project, frame / 30);
      resolver.sync(store.state.project, (nodeId) => sampler.indexOf(nodeId));
      resolver.forTarget(FAR_WING_PART_ID);
    }
    const elapsed = performance.now() - start;
    // 60 smooth frames plus occluder resolution stay far inside one frame budget.
    expect(elapsed).toBeLessThan(400);
  });
});
