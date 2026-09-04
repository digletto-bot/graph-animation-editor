import { beforeEach, describe, expect, it } from 'vitest';
import {
  addEdge,
  addNode,
  addPose,
  createOccluder,
  deleteNodes,
} from '../src/model/projectFactory.ts';
import {
  MIN_BOUNDARY_NODES,
  OccluderResolver,
  isOccluderUsable,
  occludersTargeting,
  resolveBoundaryNodeIds,
  resolveOccluderPolygon,
  validateOccluders,
} from '../src/runtime/occluders.ts';
import { BODY_PART_ID, FAR_WING_PART_ID, NEAR_WING_PART_ID } from '../src/runtime/parts.ts';
import { parseProject, serializeProject } from '../src/model/serialization.ts';
import { validateProject } from '../src/model/projectValidation.ts';
import { PoseSampler, samplePositions } from '../src/runtime/interpolation.ts';
import { resetIdCounter } from '../src/utils/ids.ts';
import { layeredProject, layeredStore } from './support/layeredProject.ts';

beforeEach(() => resetIdCounter());

/** A body triangle plus a far-wing node, and a body occluder over the triangle. */
function seedProject() {
  const project = layeredProject();
  const poseId = project.poses[0]!.id;
  const a = addNode(project, { x: 0.2, y: 0.2 }, poseId, 'A', BODY_PART_ID);
  const b = addNode(project, { x: 0.8, y: 0.2 }, poseId, 'B', BODY_PART_ID);
  const c = addNode(project, { x: 0.5, y: 0.8 }, poseId, 'C', BODY_PART_ID);
  const wing = addNode(project, { x: 0.5, y: 0.4 }, poseId, 'Wing', FAR_WING_PART_ID);
  addEdge(project, a, b, {}, BODY_PART_ID);
  const occluder = createOccluder(project, [a, b, c], {
    name: 'Body silhouette',
    ownerPartId: BODY_PART_ID,
    targetPartIds: [FAR_WING_PART_ID],
  });
  return { project, a, b, c, wing, occluder, poseId };
}

describe('occluder model', () => {
  it('stores ordered node references and no positions of its own', () => {
    const { project, a, b, c, occluder } = seedProject();
    expect(occluder.boundaryNodeIds).toEqual([a, b, c]);
    expect(JSON.stringify(project.occluders)).not.toContain('"x"');
  });

  it('resolves the boundary in authored order, dropping repeats and ghosts', () => {
    const { a, b, c } = seedProject();
    const known = new Set([a, b, c]);
    const messy = {
      id: 'o',
      name: 'o',
      ownerPartId: BODY_PART_ID,
      boundaryNodeIds: [c, a, a, 'ghost', b],
      targetPartIds: [],
      enabled: true,
      maskExpansion: 2,
    };
    expect(resolveBoundaryNodeIds(messy, known)).toEqual([c, a, b]);
    expect(isOccluderUsable(messy, known)).toBe(true);
  });

  it('reports a polygon with fewer than three usable nodes', () => {
    const { project, occluder, a } = seedProject();
    occluder.boundaryNodeIds = [a];
    const issues = validateOccluders(project);
    expect(issues.some((issue) => issue.message.includes('at least'))).toBe(true);
    expect(MIN_BOUNDARY_NODES).toBe(3);
  });

  it('reports dangling node, owner and target references', () => {
    const { project, occluder } = seedProject();
    occluder.boundaryNodeIds = [...occluder.boundaryNodeIds, 'ghost-node'];
    occluder.ownerPartId = 'ghost-part';
    occluder.targetPartIds = ['ghost-target'];
    const messages = validateOccluders(project).map((issue) => issue.message).join(' ');
    expect(messages).toMatch(/no longer exist/);
    expect(messages).toMatch(/belongs to a part that no longer exists/);
    expect(messages).toMatch(/targets 1 part/);
  });

  it('finds enabled occluders by target part, and ignores disabled ones', () => {
    const { project, occluder } = seedProject();
    expect(occludersTargeting(project, FAR_WING_PART_ID)).toHaveLength(1);
    expect(occludersTargeting(project, BODY_PART_ID)).toHaveLength(0);
    occluder.enabled = false;
    expect(occludersTargeting(project, FAR_WING_PART_ID)).toHaveLength(0);
  });

  it('supports one occluder targeting several parts', () => {
    const { project, occluder } = seedProject();
    occluder.targetPartIds = [FAR_WING_PART_ID, NEAR_WING_PART_ID];
    expect(occludersTargeting(project, FAR_WING_PART_ID)).toHaveLength(1);
    expect(occludersTargeting(project, NEAR_WING_PART_ID)).toHaveLength(1);
  });

  it('supports several occluders targeting the same part', () => {
    const { project, a, b, c } = seedProject();
    createOccluder(project, [b, c, a], {
      name: 'Near wing silhouette',
      ownerPartId: NEAR_WING_PART_ID,
      targetPartIds: [FAR_WING_PART_ID],
    });
    expect(occludersTargeting(project, FAR_WING_PART_ID)).toHaveLength(2);
  });
});

describe('occluders follow their nodes', () => {
  it('resolves the polygon from the active pose', () => {
    const { project, occluder } = seedProject();
    const polygon = resolveOccluderPolygon(occluder, project.poses[0]!.positions);
    expect(polygon).toEqual([
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.5, y: 0.8 },
    ]);
  });

  it('follows interpolated positions between poses', () => {
    const { project, occluder, a, poseId } = seedProject();
    const second = addPose(project, poseId, 'Moved');
    second.positions[a] = { x: 0.4, y: 0.6 };
    project.settings.interpolation = 'linear';

    const mid = (project.poses[0]!.time + project.poses[1]!.time) / 2;
    const polygon = resolveOccluderPolygon(occluder, samplePositions(project, mid))!;
    // First vertex has travelled; the untouched ones have not.
    expect(polygon[0]!.x).toBeGreaterThan(0.2);
    expect(polygon[0]!.x).toBeLessThan(0.4);
    expect(polygon[1]).toEqual({ x: 0.8, y: 0.2 });

    const atSecond = resolveOccluderPolygon(occluder, samplePositions(project, project.poses[1]!.time))!;
    expect(atSecond[0]).toEqual({ x: 0.4, y: 0.6 });
  });

  it('returns null instead of a degenerate polygon', () => {
    const { project, occluder, a } = seedProject();
    occluder.boundaryNodeIds = [a];
    expect(resolveOccluderPolygon(occluder, project.poses[0]!.positions)).toBeNull();
  });

  it('drops the reference when a boundary node is deleted, and keeps the rest', () => {
    const { project, occluder, a, b, c } = seedProject();
    deleteNodes(project, [b]);
    expect(occluder.boundaryNodeIds).toEqual([a, c]);
    // Still present, just reported as unusable rather than silently removed.
    expect(project.occluders).toHaveLength(1);
    expect(validateOccluders(project).length).toBeGreaterThan(0);
    expect(resolveOccluderPolygon(occluder, project.poses[0]!.positions)).toBeNull();
  });
});

describe('OccluderResolver index cache', () => {
  it('compiles boundary ids to buffer indices and filters by target', () => {
    const { project, a, b, c } = seedProject();
    const sampler = new PoseSampler();
    sampler.sample(project, 0);

    const resolver = new OccluderResolver();
    resolver.sync(project, (nodeId) => sampler.indexOf(nodeId));
    const masks = resolver.forTarget(FAR_WING_PART_ID);
    expect(masks).toHaveLength(1);
    expect([...masks[0]!.indices]).toEqual([
      sampler.indexOf(a),
      sampler.indexOf(b),
      sampler.indexOf(c),
    ]);
    expect(resolver.forTarget(BODY_PART_ID)).toHaveLength(0);
  });

  it('reuses the compiled array until the occluders or topology change', () => {
    const { project, occluder } = seedProject();
    const sampler = new PoseSampler();
    sampler.sample(project, 0);
    const resolver = new OccluderResolver();
    const indexOf = (nodeId: string) => sampler.indexOf(nodeId);

    resolver.sync(project, indexOf);
    const first = resolver.all[0];
    resolver.sync(project, indexOf);
    expect(resolver.all[0]).toBe(first);

    occluder.maskExpansion = 6;
    resolver.sync(project, indexOf);
    expect(resolver.all[0]).not.toBe(first);
    expect(resolver.all[0]!.maskExpansion).toBe(6);
  });

  it('leaves a disabled occluder out of the mask list entirely', () => {
    const { project, occluder } = seedProject();
    const sampler = new PoseSampler();
    sampler.sample(project, 0);
    const resolver = new OccluderResolver();
    occluder.enabled = false;
    resolver.sync(project, (nodeId) => sampler.indexOf(nodeId));
    expect(resolver.forTarget(FAR_WING_PART_ID)).toHaveLength(0);
  });
});

describe('occluder editing through the store', () => {
  function storeWithTriangle() {
    const store = layeredStore();
    const a = store.addNodeAt({ x: 0.2, y: 0.2 });
    const b = store.addNodeAt({ x: 0.8, y: 0.2 });
    const c = store.addNodeAt({ x: 0.5, y: 0.8 });
    return { store, a, b, c };
  }

  it('creates an occluder from three nodes and undoes it as one step', () => {
    const { store, a, b, c } = storeWithTriangle();
    const id = store.addOccluder([a, b, c], { ownerPartId: BODY_PART_ID })!;
    expect(id).toBeTruthy();
    expect(store.state.project.occluders).toHaveLength(1);
    expect(store.state.selectedOccluderId).toBe(id);

    expect(store.undo()).toBe(true);
    expect(store.state.project.occluders).toHaveLength(0);
    expect(store.state.selectedOccluderId).toBeNull();

    expect(store.redo()).toBe(true);
    expect(store.state.project.occluders).toHaveLength(1);
    expect(store.state.project.occluders[0]!.boundaryNodeIds).toEqual([a, b, c]);
  });

  it('refuses fewer than three distinct nodes', () => {
    const { store, a, b } = storeWithTriangle();
    expect(store.addOccluder([a, b, a])).toBeNull();
    expect(store.state.project.occluders).toHaveLength(0);
    expect(store.state.status?.tone).toBe('error');
  });

  it('defaults a body occluder to masking the far wing', () => {
    const { store } = storeWithTriangle();
    expect(store.suggestedOccluderTargets(BODY_PART_ID)).toEqual([FAR_WING_PART_ID]);
    expect(store.suggestedOccluderTargets(FAR_WING_PART_ID)).toEqual([]);
  });

  it('edits targets, order and mask settings undoably', () => {
    const { store, a, b, c } = storeWithTriangle();
    const id = store.addOccluder([a, b, c], { ownerPartId: BODY_PART_ID, targetPartIds: [] })!;

    store.toggleOccluderTarget(id, FAR_WING_PART_ID);
    expect(store.selectedOccluder!.targetPartIds).toEqual([FAR_WING_PART_ID]);
    store.toggleOccluderTarget(id, FAR_WING_PART_ID);
    expect(store.selectedOccluder!.targetPartIds).toEqual([]);

    store.reverseOccluderBoundary(id);
    expect(store.selectedOccluder!.boundaryNodeIds).toEqual([c, b, a]);

    store.moveOccluderBoundaryNode(id, c, 1);
    expect(store.selectedOccluder!.boundaryNodeIds).toEqual([b, c, a]);

    store.removeOccluderBoundaryNode(id, c);
    expect(store.selectedOccluder!.boundaryNodeIds).toEqual([b, a]);

    store.updateOccluder(id, { maskExpansion: 5, enabled: false });
    expect(store.selectedOccluder!.maskExpansion).toBe(5);
    expect(store.selectedOccluder!.enabled).toBe(false);

    // Each edit was its own undo step, and undoing walks straight back.
    while (store.canUndo) store.undo();
    expect(store.state.project.occluders).toHaveLength(0);
  });

  it('deletes an occluder undoably and clears the selection', () => {
    const { store, a, b, c } = storeWithTriangle();
    const id = store.addOccluder([a, b, c])!;
    store.removeOccluder(id);
    expect(store.state.project.occluders).toHaveLength(0);
    expect(store.state.selectedOccluderId).toBeNull();
    store.undo();
    expect(store.state.project.occluders).toHaveLength(1);
  });

  it('makes an occluder read-only while its owner part is locked', () => {
    const { store, a, b, c } = storeWithTriangle();
    const id = store.addOccluder([a, b, c], { ownerPartId: BODY_PART_ID })!;
    expect(store.isOccluderInteractive(id)).toBe(true);
    store.updatePartDisplay(BODY_PART_ID, { locked: true });
    expect(store.isOccluderInteractive(id)).toBe(false);
  });
});

describe('occluder serialization', () => {
  it('round trips occluders with ordered references and mask settings', () => {
    const { project } = seedProject();
    project.occluders[0]!.maskExpansion = 4.5;
    const result = parseProject(serializeProject(project));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.occluders).toEqual(project.occluders);
  });

  it('rejects an occluder whose owner part does not exist', () => {
    const result = validateProject({
      version: 2,
      parts: [{ id: BODY_PART_ID, name: 'Body', role: 'body', zIndex: 10, renderEnabled: true }],
      nodes: [
        { id: 'n1', name: 'a', partId: BODY_PART_ID },
        { id: 'n2', name: 'b', partId: BODY_PART_ID },
        { id: 'n3', name: 'c', partId: BODY_PART_ID },
      ],
      edges: [],
      poses: [
        {
          id: 'p1',
          name: 'p',
          time: 0,
          positions: { n1: { x: 0, y: 0 }, n2: { x: 1, y: 0 }, n3: { x: 0, y: 1 } },
        },
      ],
      occluders: [
        {
          id: 'o1',
          name: 'Ghost owner',
          ownerPartId: 'nope',
          boundaryNodeIds: ['n1', 'n2', 'n3'],
          targetPartIds: [],
          enabled: true,
          maskExpansion: 2,
        },
      ],
      settings: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/part that does not exist/);
  });

  it('rejects an imported occluder left with fewer than three valid nodes', () => {
    const result = validateProject({
      version: 2,
      parts: [{ id: BODY_PART_ID, name: 'Body', role: 'body', zIndex: 10, renderEnabled: true }],
      nodes: [{ id: 'n1', name: 'a', partId: BODY_PART_ID }],
      edges: [],
      poses: [{ id: 'p1', name: 'p', time: 0, positions: { n1: { x: 0, y: 0 } } }],
      occluders: [
        {
          id: 'o1',
          name: 'Too small',
          ownerPartId: BODY_PART_ID,
          boundaryNodeIds: ['n1', 'ghost', 'ghost2'],
          targetPartIds: [],
          enabled: true,
          maskExpansion: 2,
        },
      ],
      settings: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/at least 3 valid boundary nodes/);
  });
});

describe('leaving the occluder inspector', () => {
  function selected() {
    const store = layeredStore();
    const a = store.addNodeAt({ x: 0.2, y: 0.2 });
    const b = store.addNodeAt({ x: 0.8, y: 0.2 });
    const c = store.addNodeAt({ x: 0.5, y: 0.8 });
    const id = store.addOccluder([a, b, c])!;
    return { store, a, b, c, id };
  }

  it('clears the occluder on the same clearSelection Escape uses', () => {
    const { store } = selected();
    // The regression: selecting an occluder empties the node and edge lists, so
    // clearSelection() saw nothing to change and returned before deselecting.
    store.clearSelection();
    expect(store.state.selectedOccluderId).toBeNull();
    expect(store.selectedOccluder).toBeNull();
  });

  it('notifies listeners so the inspector and overlay repaint', () => {
    const { store } = selected();
    const changes: string[] = [];
    store.subscribe((keys) => changes.push(...keys));
    store.clearSelection();
    expect(changes).toContain('selection');
    expect(changes).toContain('occluders');
  });

  it('clears the occluder when a node is picked instead', () => {
    const { store, a } = selected();
    store.setSelection([a], []);
    expect(store.state.selectedOccluderId).toBeNull();
    expect(store.state.selectedNodeIds).toEqual([a]);
  });

  it('leaves the occluder alone when nothing selects it', () => {
    const { store, id } = selected();
    store.setStatus('unrelated', 'info');
    expect(store.state.selectedOccluderId).toBe(id);
  });

  it('is editor state, so leaving costs no history entry', () => {
    const { store } = selected();
    store.clearSelection();
    // Undo must still reach past the deselection to the occluder creation.
    expect(store.undo()).toBe(true);
    expect(store.state.project.occluders).toHaveLength(0);
  });

  it('still returns to the occluder when it is selected again', () => {
    const { store, id } = selected();
    store.clearSelection();
    store.selectOccluder(id);
    expect(store.selectedOccluder?.id).toBe(id);
  });
});
