import { describe, expect, it } from 'vitest';
import { EditorStore } from '../src/state/EditorStore.ts';
import { HistoryManager } from '../src/state/HistoryManager.ts';

function storeWithTriangle() {
  const store = new EditorStore();
  const a = store.addNodeAt({ x: 0.1, y: 0.1 });
  const b = store.addNodeAt({ x: 0.9, y: 0.1 });
  const c = store.addNodeAt({ x: 0.5, y: 0.9 });
  store.addEdgeBetween(a, b);
  store.addEdgeBetween(b, c);
  return { store, a, b, c };
}

describe('HistoryManager', () => {
  it('caps the number of stored entries', () => {
    const history = new HistoryManager<number>(3);
    for (let i = 0; i < 10; i += 1) history.push(i);
    expect(history.size).toBe(3);
    expect(history.undo(99)).toBe(9);
  });

  it('clears the redo stack on a new push', () => {
    const history = new HistoryManager<string>();
    history.push('a');
    history.undo('b');
    expect(history.canRedo).toBe(true);
    history.push('c');
    expect(history.canRedo).toBe(false);
  });
});

describe('undo and redo', () => {
  it('undoes node creation', () => {
    const store = new EditorStore();
    store.addNodeAt({ x: 0.5, y: 0.5 });
    expect(store.state.project.nodes).toHaveLength(1);
    expect(store.undo()).toBe(true);
    expect(store.state.project.nodes).toHaveLength(0);
    expect(store.redo()).toBe(true);
    expect(store.state.project.nodes).toHaveLength(1);
  });

  it('undoes edge creation without touching nodes', () => {
    const { store } = storeWithTriangle();
    expect(store.state.project.edges).toHaveLength(2);
    store.undo();
    expect(store.state.project.edges).toHaveLength(1);
    expect(store.state.project.nodes).toHaveLength(3);
  });

  it('does not push history for a rejected duplicate edge', () => {
    const { store, a, b } = storeWithTriangle();
    const edgeCount = store.state.project.edges.length;
    store.addEdgeBetween(a, b);
    expect(store.state.project.edges).toHaveLength(edgeCount);
    // One undo should still remove the last *real* edge.
    store.undo();
    expect(store.state.project.edges).toHaveLength(edgeCount - 1);
  });

  it('restores deleted nodes and their edges together', () => {
    const { store, b } = storeWithTriangle();
    store.setSelection([b], []);
    store.deleteSelection();
    expect(store.state.project.nodes).toHaveLength(2);
    expect(store.state.project.edges).toHaveLength(0);

    store.undo();
    expect(store.state.project.nodes).toHaveLength(3);
    expect(store.state.project.edges).toHaveLength(2);
  });

  it('treats a whole drag as one history entry', () => {
    const { store, a } = storeWithTriangle();
    const before = store.positionOf(a);

    store.beginTransaction('Move nodes');
    for (let step = 1; step <= 20; step += 1) {
      store.setNodePositions({ [a]: { x: 0.1 + step * 0.01, y: 0.1 } });
    }
    store.endTransaction();

    expect(store.positionOf(a).x).toBeCloseTo(0.3, 6);
    store.undo();
    expect(store.positionOf(a)).toEqual(before);
  });

  it('cancels an in-flight drag back to its starting point', () => {
    const { store, a } = storeWithTriangle();
    const before = store.positionOf(a);
    store.beginTransaction('Move nodes');
    store.setNodePositions({ [a]: { x: 0.8, y: 0.8 } });
    store.cancelTransaction();
    expect(store.positionOf(a)).toEqual(before);
    expect(store.hasPendingTransaction).toBe(false);
  });

  it('undoes pose creation and deletion', () => {
    const { store } = storeWithTriangle();
    store.addPoseAfterActive();
    expect(store.state.project.poses).toHaveLength(2);
    const addedId = store.state.activePoseId;

    store.deletePoseById(addedId);
    expect(store.state.project.poses).toHaveLength(1);
    store.undo();
    expect(store.state.project.poses).toHaveLength(2);
    store.undo();
    expect(store.state.project.poses).toHaveLength(1);
  });

  it('undoes inspector property changes', () => {
    const { store } = storeWithTriangle();
    const edgeId = store.state.project.edges[0]!.id;
    store.updateEdge(edgeId, { brightness: 1.8 });
    expect(store.edgeById(edgeId)!.brightness).toBe(1.8);
    store.undo();
    expect(store.edgeById(edgeId)!.brightness).toBe(1);
  });

  it('undoes starting a new project', () => {
    const { store } = storeWithTriangle();
    store.newProject();
    expect(store.state.project.nodes).toHaveLength(0);
    store.undo();
    expect(store.state.project.nodes).toHaveLength(3);
    expect(store.state.project.edges).toHaveLength(2);
  });

  it('reports when there is nothing to undo or redo', () => {
    const store = new EditorStore();
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(false);
    expect(store.canUndo).toBe(false);
  });
});

describe('pose isolation', () => {
  it('changes positions in the active pose only', () => {
    const { store, a } = storeWithTriangle();
    const firstPoseId = store.state.activePoseId;
    store.addPoseAfterActive();
    const secondPoseId = store.state.activePoseId;
    expect(secondPoseId).not.toBe(firstPoseId);

    store.beginTransaction('Move nodes');
    store.setNodePositions({ [a]: { x: 0.75, y: 0.75 } });
    store.endTransaction();

    const first = store.state.project.poses.find((pose) => pose.id === firstPoseId)!;
    const second = store.state.project.poses.find((pose) => pose.id === secondPoseId)!;
    expect(second.positions[a]).toEqual({ x: 0.75, y: 0.75 });
    expect(first.positions[a]).toEqual({ x: 0.1, y: 0.1 });
  });

  it('applies topology changes to every pose', () => {
    const { store } = storeWithTriangle();
    store.addPoseAfterActive();
    const newNode = store.addNodeAt({ x: 0.33, y: 0.33 });
    for (const pose of store.state.project.poses) {
      expect(pose.positions[newNode]).toEqual({ x: 0.33, y: 0.33 });
    }
  });

  it('will not delete the only pose', () => {
    const store = new EditorStore();
    expect(store.deletePoseById(store.state.activePoseId)).toBe(false);
    expect(store.state.project.poses).toHaveLength(1);
  });
});

describe('selection', () => {
  it('toggles items with shift-click semantics', () => {
    const { store, a, b } = storeWithTriangle();
    store.setSelection([a], []);
    store.toggleSelection({ kind: 'node', id: b });
    expect(store.state.selectedNodeIds.sort()).toEqual([a, b].sort());
    store.toggleSelection({ kind: 'node', id: b });
    expect(store.state.selectedNodeIds).toEqual([a]);
  });

  it('drops selections that no longer exist after undo', () => {
    const { store, b } = storeWithTriangle();
    store.setSelection([b], []);
    store.deleteSelection();
    expect(store.state.selectedNodeIds).toEqual([]);
    store.undo();
    expect(store.state.selectedNodeIds).toEqual([b]);
  });

  it('notifies subscribers on selection change', () => {
    const { store, a } = storeWithTriangle();
    let calls = 0;
    store.subscribe((changes) => {
      if (changes.has('selection')) calls += 1;
    });
    store.setSelection([a], []);
    store.setSelection([a], []); // identical, should not re-emit
    expect(calls).toBe(1);
  });
});
