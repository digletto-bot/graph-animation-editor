import { describe, expect, it } from 'vitest';
import {
  addEdge,
  addNode,
  assignNodesToPart,
  edgesInsideNodeSet,
} from '../src/model/projectFactory.ts';
import { BODY_PART_ID, FAR_WING_PART_ID, NEAR_WING_PART_ID } from '../src/runtime/parts.ts';
import { midpoint, segmentIntersectsRect, segmentsIntersect } from '../src/utils/geometry.ts';
import { layeredProject, layeredStore } from './support/layeredProject.ts';

/** Body chain a-b-c plus a wing pair d-e, and an edge bridging c to d. */
function seed() {
  const store = layeredStore();
  const a = store.addNodeAt({ x: 0.1, y: 0.5 });
  const b = store.addNodeAt({ x: 0.3, y: 0.5 });
  const c = store.addNodeAt({ x: 0.5, y: 0.5 });
  const d = store.addNodeAt({ x: 0.7, y: 0.5 });
  const e = store.addNodeAt({ x: 0.9, y: 0.5 });
  const ab = store.addEdgeBetween(a, b)!;
  const bc = store.addEdgeBetween(b, c)!;
  const cd = store.addEdgeBetween(c, d)!;
  const de = store.addEdgeBetween(d, e)!;
  return { store, a, b, c, d, e, ab, bc, cd, de };
}

describe('edges follow their nodes between parts', () => {
  it('takes internal edges along and leaves spanning edges put', () => {
    const { store, d, e, cd, de, ab } = seed();

    store.setSelection([d, e], []);
    store.assignSelectionToPart(NEAR_WING_PART_ID);

    // Both endpoints moved, so this edge moved with them.
    expect(store.edgeById(de)!.partId).toBe(NEAR_WING_PART_ID);
    // c stayed behind, so the bridging edge keeps the part it had.
    expect(store.edgeById(cd)!.partId).toBe(BODY_PART_ID);
    expect(store.edgeById(ab)!.partId).toBe(BODY_PART_ID);
  });

  it('never leaves an edge whose endpoints all left the part', () => {
    const { store, a, b, c, ab, bc } = seed();
    store.setSelection([a, b, c], []);
    store.assignSelectionToPart(FAR_WING_PART_ID);

    for (const edgeId of [ab, bc]) {
      const edge = store.edgeById(edgeId)!;
      const from = store.nodeById(edge.from)!;
      const to = store.nodeById(edge.to)!;
      // The bug this guards: an edge drawn on a layer whose endpoints are all
      // on another layer, leaving lines with no visible nodes.
      expect(edge.partId === from.partId || edge.partId === to.partId).toBe(true);
    }
    expect(store.edgeById(ab)!.partId).toBe(FAR_WING_PART_ID);
  });

  it('moves as one undoable step', () => {
    const { store, d, e, de } = seed();
    store.setSelection([d, e], []);
    store.assignSelectionToPart(NEAR_WING_PART_ID);
    expect(store.undo()).toBe(true);
    expect(store.nodeById(d)!.partId).toBe(BODY_PART_ID);
    expect(store.edgeById(de)!.partId).toBe(BODY_PART_ID);
  });

  it('can be opted out of at the model level', () => {
    const project = layeredProject();
    const poseId = project.poses[0]!.id;
    const a = addNode(project, { x: 0.1, y: 0.1 }, poseId);
    const b = addNode(project, { x: 0.2, y: 0.2 }, poseId);
    const ab = addEdge(project, a, b)!;

    expect(edgesInsideNodeSet(project, [a, b])).toEqual([ab]);
    expect(edgesInsideNodeSet(project, [a])).toEqual([]);

    assignNodesToPart(project, [a, b], NEAR_WING_PART_ID, false);
    expect(project.edges[0]!.partId).toBe(BODY_PART_ID);
  });

  it('still cascades edge deletion when nodes are deleted', () => {
    const { store, a, b, c } = seed();
    store.setSelection([a, b, c], []);
    store.deleteSelection();
    // ab, bc and the bridging cd all went with their nodes.
    expect(store.state.project.edges).toHaveLength(1);
    expect(store.state.project.nodes).toHaveLength(2);
  });
});

describe('redrawing an edge that already exists on another part', () => {
  /** The state the earlier part-move bug left behind: nodes moved, edge did not. */
  function strandedEdge() {
    const store = layeredStore();
    const a = store.addNodeAt({ x: 0.2, y: 0.2 });
    const b = store.addNodeAt({ x: 0.4, y: 0.2 });
    const ab = store.addEdgeBetween(a, b)!;
    for (const node of store.state.project.nodes) node.partId = NEAR_WING_PART_ID;
    store.setActivePart(NEAR_WING_PART_ID);
    return { store, a, b, ab };
  }

  it('moves the existing edge to the active part instead of refusing', () => {
    const { store, a, b, ab } = strandedEdge();
    expect(store.edgeById(ab)!.partId).toBe(BODY_PART_ID);

    const result = store.addEdgeBetween(a, b);

    expect(result).toBe(ab);
    expect(store.edgeById(ab)!.partId).toBe(NEAR_WING_PART_ID);
    // Never a second edge between the same pair.
    expect(store.state.project.edges).toHaveLength(1);
    expect(store.state.status?.tone).toBe('success');
    expect(store.state.status?.message).toMatch(/Moved that edge/);
    expect(store.state.selectedEdgeIds).toEqual([ab]);
  });

  it('undoes that move as one step', () => {
    const { store, a, b, ab } = strandedEdge();
    store.addEdgeBetween(a, b);
    expect(store.undo()).toBe(true);
    expect(store.edgeById(ab)!.partId).toBe(BODY_PART_ID);
    expect(store.state.project.edges).toHaveLength(1);
  });

  it('still refuses when the edge is already on the active part', () => {
    const { store, a, b } = seed();
    const undoableBefore = store.canUndo;
    expect(store.addEdgeBetween(a, b)).toBeNull();
    expect(store.state.project.edges).toHaveLength(4);
    // A refusal is not an edit, so it leaves history completely alone.
    expect(store.canUndo).toBe(undoableBefore);
    expect(store.canRedo).toBe(false);
  });

  it('still refuses a self-edge', () => {
    const { store, a } = seed();
    expect(store.addEdgeBetween(a, a)).toBeNull();
    expect(store.state.project.edges).toHaveLength(4);
  });
});

describe('selection mode', () => {
  it('defaults to picking both kinds', () => {
    const store = layeredStore();
    expect(store.state.selectionMode).toBe('both');
    expect(store.canPickNodes).toBe(true);
    expect(store.canPickEdges).toBe(true);
  });

  it('drops the other kind from the selection when narrowing', () => {
    const { store, a, b, ab } = seed();
    store.setSelection([a, b], [ab]);

    store.setSelectionMode('edges');
    expect(store.state.selectedNodeIds).toEqual([]);
    expect(store.state.selectedEdgeIds).toEqual([ab]);
    expect(store.canPickNodes).toBe(false);

    store.setSelectionMode('nodes');
    expect(store.state.selectedEdgeIds).toEqual([]);
    expect(store.canPickEdges).toBe(false);
  });

  it('deletes a selection of edges without touching the nodes', () => {
    const { store, ab, bc } = seed();
    store.setSelectionMode('edges');
    store.setSelection([], [ab, bc]);
    store.deleteSelection();

    expect(store.state.project.edges).toHaveLength(2);
    expect(store.state.project.nodes).toHaveLength(5);
    expect(store.edgeById(ab)).toBeUndefined();
  });

  it('is editor state: no history entry and nothing in the project', () => {
    const store = layeredStore();
    store.setSelectionMode('edges');
    expect(store.canUndo).toBe(false);
    expect(JSON.stringify(store.state.project)).not.toContain('selectionMode');
  });
});

describe('marquee geometry for edges', () => {
  const rect = { x: 10, y: 10, width: 20, height: 20 };

  it('catches a segment that merely crosses the box', () => {
    // Both endpoints outside, passing straight through.
    expect(segmentIntersectsRect({ x: 0, y: 20 }, { x: 100, y: 20 }, rect)).toBe(true);
    expect(segmentIntersectsRect({ x: 20, y: 0 }, { x: 20, y: 100 }, rect)).toBe(true);
  });

  it('catches a segment with one endpoint inside', () => {
    expect(segmentIntersectsRect({ x: 15, y: 15 }, { x: 500, y: 500 }, rect)).toBe(true);
  });

  it('rejects a segment that misses entirely', () => {
    expect(segmentIntersectsRect({ x: 0, y: 0 }, { x: 5, y: 100 }, rect)).toBe(false);
    expect(segmentIntersectsRect({ x: 40, y: 0 }, { x: 40, y: 100 }, rect)).toBe(false);
    expect(segmentIntersectsRect({ x: 0, y: 50 }, { x: 100, y: 50 }, rect)).toBe(false);
  });

  it('handles a corner-clipping diagonal', () => {
    expect(segmentIntersectsRect({ x: 0, y: 20 }, { x: 20, y: 0 }, rect)).toBe(true);
    expect(segmentIntersectsRect({ x: 0, y: 8 }, { x: 8, y: 0 }, rect)).toBe(false);
  });

  it('detects plain segment crossings and collinear overlap', () => {
    expect(
      segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }),
    ).toBe(true);
    expect(
      segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 15, y: 0 }),
    ).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 0 }, { x: 6, y: 0 })).toBe(
      false,
    );
  });

  it('takes the midpoint used by the lasso', () => {
    expect(midpoint({ x: 0, y: 10 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 15 });
  });
});
