import { beforeEach, describe, expect, it } from 'vitest';
import {
  addEdge,
  addNode,
  addPart,
  createEmptyProject,
  deletePart,
  isPartEmpty,
  movePartOrder,
  partContents,
  reassignPartContents,
} from '../src/model/projectFactory.ts';
import {
  BODY_PART_ID,
  CORE_PART_IDS,
  FAR_WING_PART_ID,
  NEAR_WING_PART_ID,
  isCorePart,
  renderablePartsInOrder,
  resolvePartStates,
  sortPartsByZ,
} from '../src/model/parts.ts';
import { EditorStore } from '../src/state/EditorStore.ts';
import { parseProject, serializeProject } from '../src/model/serialization.ts';
import { validateProject } from '../src/model/projectValidation.ts';
import { resetIdCounter } from '../src/utils/ids.ts';
import type { PartDisplayState } from '../src/model/types.ts';

beforeEach(() => resetIdCounter());

function display(overrides: Record<string, Partial<PartDisplayState>>) {
  const base: Record<string, PartDisplayState> = {};
  for (const id of CORE_PART_IDS) {
    base[id] = { locked: false, hidden: false, solo: false, xray: false, ...overrides[id] };
  }
  return base;
}

describe('default parts', () => {
  it('creates far wing, body and near wing with the expected back-to-front order', () => {
    const project = createEmptyProject();
    expect(project.parts.map((part) => part.id)).toEqual([
      FAR_WING_PART_ID,
      BODY_PART_ID,
      NEAR_WING_PART_ID,
    ]);
    expect(sortPartsByZ(project.parts).map((part) => part.role)).toEqual([
      'far-wing',
      'body',
      'near-wing',
    ]);
  });

  it('protects the three core parts from deletion', () => {
    const project = createEmptyProject();
    for (const id of CORE_PART_IDS) {
      expect(isCorePart(id)).toBe(true);
      expect(deletePart(project, id)).toEqual({ ok: false, reason: 'core-part' });
    }
    expect(project.parts).toHaveLength(3);
  });

  it('resolves render order and skips parts with rendering switched off', () => {
    const project = createEmptyProject();
    project.parts.find((part) => part.id === BODY_PART_ID)!.renderEnabled = false;
    expect(renderablePartsInOrder(project).map((part) => part.id)).toEqual([
      FAR_WING_PART_ID,
      NEAR_WING_PART_ID,
    ]);
  });

  it('reorders by rewriting zIndex, keeping the list compact', () => {
    const project = createEmptyProject();
    expect(movePartOrder(project, FAR_WING_PART_ID, 1)).toBe(true);
    expect(sortPartsByZ(project.parts).map((part) => part.id)).toEqual([
      BODY_PART_ID,
      FAR_WING_PART_ID,
      NEAR_WING_PART_ID,
    ]);
    // Off the end of the stack is refused rather than clamped silently.
    expect(movePartOrder(project, NEAR_WING_PART_ID, 1)).toBe(false);
  });
});

describe('part membership', () => {
  it('assigns new geometry to the active part', () => {
    const store = new EditorStore();
    store.setActivePart(FAR_WING_PART_ID);
    const a = store.addNodeAt({ x: 0.2, y: 0.2 });
    const b = store.addNodeAt({ x: 0.4, y: 0.4 });
    const edgeId = store.addEdgeBetween(a, b)!;

    expect(store.nodeById(a)!.partId).toBe(FAR_WING_PART_ID);
    expect(store.nodeById(b)!.partId).toBe(FAR_WING_PART_ID);
    expect(store.edgeById(edgeId)!.partId).toBe(FAR_WING_PART_ID);
  });

  it('lets an edge span two parts while keeping its own layer', () => {
    const store = new EditorStore();
    const body = store.addNodeAt({ x: 0.2, y: 0.2 });
    store.setActivePart(NEAR_WING_PART_ID);
    const wing = store.addNodeAt({ x: 0.6, y: 0.6 });
    const edgeId = store.addEdgeBetween(body, wing)!;

    expect(store.nodeById(body)!.partId).toBe(BODY_PART_ID);
    expect(store.nodeById(wing)!.partId).toBe(NEAR_WING_PART_ID);
    expect(store.edgeById(edgeId)!.partId).toBe(NEAR_WING_PART_ID);
  });

  it('never deletes contents with a part, and reassigns only when told to', () => {
    const project = createEmptyProject();
    const extra = addPart(project, 'Tail');
    const poseId = project.poses[0]!.id;
    const a = addNode(project, { x: 0.1, y: 0.1 }, poseId, undefined, extra.id);
    const b = addNode(project, { x: 0.2, y: 0.2 }, poseId, undefined, extra.id);
    addEdge(project, a, b, {}, extra.id);

    expect(isPartEmpty(project, extra.id)).toBe(false);
    const refused = deletePart(project, extra.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('not-empty');
      expect(refused.contents!.nodeIds).toHaveLength(2);
    }
    // Nothing was removed by the refused attempt.
    expect(project.parts).toHaveLength(4);
    expect(project.nodes).toHaveLength(2);

    const accepted = deletePart(project, extra.id, BODY_PART_ID);
    expect(accepted.ok).toBe(true);
    expect(project.parts).toHaveLength(3);
    expect(project.nodes.every((node) => node.partId === BODY_PART_ID)).toBe(true);
    expect(project.edges.every((edge) => edge.partId === BODY_PART_ID)).toBe(true);
  });

  it('remaps occluder owners and targets when a part is reassigned', () => {
    const project = createEmptyProject();
    const extra = addPart(project, 'Tail');
    project.occluders.push({
      id: 'occ1',
      name: 'Tail mask',
      ownerPartId: extra.id,
      boundaryNodeIds: [],
      targetPartIds: [extra.id, FAR_WING_PART_ID],
      enabled: true,
      maskExpansion: 2,
    });
    reassignPartContents(project, extra.id, BODY_PART_ID);
    expect(project.occluders[0]!.ownerPartId).toBe(BODY_PART_ID);
    expect(project.occluders[0]!.targetPartIds).toEqual([BODY_PART_ID, FAR_WING_PART_ID]);
    expect(partContents(project, extra.id).occluderIds).toHaveLength(0);
  });
});

describe('editor part display state', () => {
  it('locks without hiding, and makes the part non-interactive', () => {
    const project = createEmptyProject();
    const states = resolvePartStates(project.parts, display({ [BODY_PART_ID]: { locked: true } }));
    expect(states.get(BODY_PART_ID)).toMatchObject({ visible: true, interactive: false, locked: true });
    expect(states.get(FAR_WING_PART_ID)).toMatchObject({ visible: true, interactive: true });
  });

  it('hides a part and stops it being picked', () => {
    const project = createEmptyProject();
    const states = resolvePartStates(project.parts, display({ [FAR_WING_PART_ID]: { hidden: true } }));
    expect(states.get(FAR_WING_PART_ID)).toMatchObject({ visible: false, interactive: false });
  });

  it('supports several soloed parts at once', () => {
    const project = createEmptyProject();
    const states = resolvePartStates(
      project.parts,
      display({ [BODY_PART_ID]: { solo: true }, [NEAR_WING_PART_ID]: { solo: true } }),
    );
    expect(states.get(BODY_PART_ID)!.visible).toBe(true);
    expect(states.get(NEAR_WING_PART_ID)!.visible).toBe(true);
    expect(states.get(FAR_WING_PART_ID)!.visible).toBe(false);
  });

  it('lets solo override an explicit hide on the same part', () => {
    const project = createEmptyProject();
    const states = resolvePartStates(
      project.parts,
      display({ [FAR_WING_PART_ID]: { solo: true, hidden: true } }),
    );
    expect(states.get(FAR_WING_PART_ID)!.visible).toBe(true);
  });

  it('only reports x-ray for a part that is actually on screen', () => {
    const project = createEmptyProject();
    const states = resolvePartStates(
      project.parts,
      display({ [FAR_WING_PART_ID]: { xray: true, hidden: true } }),
    );
    expect(states.get(FAR_WING_PART_ID)!.xray).toBe(false);
  });
});

describe('locking through the store', () => {
  it('drops locked items from the selection and refuses to move them', () => {
    const store = new EditorStore();
    store.setActivePart(FAR_WING_PART_ID);
    const wing = store.addNodeAt({ x: 0.3, y: 0.3 });
    store.setSelection([wing]);
    expect(store.state.selectedNodeIds).toEqual([wing]);

    store.updatePartDisplay(FAR_WING_PART_ID, { locked: true });
    expect(store.state.selectedNodeIds).toEqual([]);
    expect(store.isNodeInteractive(wing)).toBe(false);

    // Neither re-selection nor an inspector edit gets through.
    store.setSelection([wing]);
    expect(store.state.selectedNodeIds).toEqual([]);
    store.setNodePosition(wing, { x: 0.9, y: 0.9 });
    expect(store.positionOf(wing)).toEqual({ x: 0.3, y: 0.3 });
    store.updateNode(wing, { name: 'Renamed' });
    expect(store.nodeById(wing)!.name).not.toBe('Renamed');
  });

  it('keeps editor display state out of the project and out of history', () => {
    const store = new EditorStore();
    store.addNodeAt({ x: 0.5, y: 0.5 });
    const historyBefore = store.canUndo;
    store.updatePartDisplay(BODY_PART_ID, { hidden: true, xray: true, solo: true });

    expect(store.canUndo).toBe(historyBefore);
    const exported = JSON.parse(serializeProject(store.state.project)) as Record<string, unknown>;
    expect(JSON.stringify(exported)).not.toContain('xray');
    expect(JSON.stringify(exported)).not.toContain('solo');
    expect(JSON.stringify(exported)).not.toContain('hidden');
  });

  it('clears every solo flag at once', () => {
    const store = new EditorStore();
    store.updatePartDisplay(BODY_PART_ID, { solo: true });
    store.updatePartDisplay(NEAR_WING_PART_ID, { solo: true });
    store.clearSolo();
    expect(store.partStateOf(FAR_WING_PART_ID).visible).toBe(true);
  });
});

describe('part serialization', () => {
  it('round trips parts and part membership', () => {
    const store = new EditorStore();
    store.setActivePart(NEAR_WING_PART_ID);
    const a = store.addNodeAt({ x: 0.2, y: 0.2 });
    const b = store.addNodeAt({ x: 0.5, y: 0.5 });
    store.addEdgeBetween(a, b);
    store.movePart(FAR_WING_PART_ID, 1);

    const before = store.state.project;
    const result = parseProject(serializeProject(before));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.project.parts).toEqual(sortPartsByZ(before.parts));
    expect(result.project.nodes.map((node) => node.partId)).toEqual(
      before.nodes.map((node) => node.partId),
    );
    expect(result.project.edges.map((edge) => edge.partId)).toEqual(
      before.edges.map((edge) => edge.partId),
    );
  });

  it('moves nodes and edges with an unknown part reference to the body', () => {
    const result = validateProject({
      version: 2,
      parts: [{ id: BODY_PART_ID, name: 'Body', role: 'body', zIndex: 10, renderEnabled: true }],
      nodes: [
        { id: 'n1', name: 'a', partId: 'ghost-part' },
        { id: 'n2', name: 'b', partId: BODY_PART_ID },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', partId: 'ghost-part' }],
      poses: [
        {
          id: 'p1',
          name: 'p',
          time: 0,
          positions: { n1: { x: 0, y: 0 }, n2: { x: 1, y: 1 } },
        },
      ],
      occluders: [],
      settings: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.nodes.every((node) => node.partId === BODY_PART_ID)).toBe(true);
    expect(result.project.edges[0]!.partId).toBe(BODY_PART_ID);
    expect(result.warnings.join(' ')).toMatch(/unknown part/);
  });

  it('rejects duplicate part ids', () => {
    const result = validateProject({
      version: 2,
      parts: [
        { id: 'dup', name: 'A', role: 'other', zIndex: 0, renderEnabled: true },
        { id: 'dup', name: 'B', role: 'other', zIndex: 10, renderEnabled: true },
      ],
      nodes: [],
      edges: [],
      poses: [{ id: 'p1', name: 'p', time: 0, positions: {} }],
      settings: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/Duplicate part id/);
  });
});

describe('undo and redo for part operations', () => {
  it('undoes a part assignment change', () => {
    const store = new EditorStore();
    const node = store.addNodeAt({ x: 0.3, y: 0.3 });
    expect(store.nodeById(node)!.partId).toBe(BODY_PART_ID);

    store.setNodePart(node, NEAR_WING_PART_ID);
    expect(store.nodeById(node)!.partId).toBe(NEAR_WING_PART_ID);
    expect(store.undo()).toBe(true);
    expect(store.nodeById(node)!.partId).toBe(BODY_PART_ID);
    expect(store.redo()).toBe(true);
    expect(store.nodeById(node)!.partId).toBe(NEAR_WING_PART_ID);
  });

  it('undoes a multi-selection reassignment as one step', () => {
    const store = new EditorStore();
    const a = store.addNodeAt({ x: 0.2, y: 0.2 });
    const b = store.addNodeAt({ x: 0.4, y: 0.4 });
    const edge = store.addEdgeBetween(a, b)!;
    store.setSelection([a, b], [edge]);

    store.assignSelectionToPart(FAR_WING_PART_ID);
    expect(store.nodeById(a)!.partId).toBe(FAR_WING_PART_ID);
    expect(store.edgeById(edge)!.partId).toBe(FAR_WING_PART_ID);

    expect(store.undo()).toBe(true);
    expect(store.nodeById(a)!.partId).toBe(BODY_PART_ID);
    expect(store.nodeById(b)!.partId).toBe(BODY_PART_ID);
    expect(store.edgeById(edge)!.partId).toBe(BODY_PART_ID);
  });

  it('undoes part creation and deletion', () => {
    const store = new EditorStore();
    const id = store.createPart('Tail');
    expect(store.state.project.parts).toHaveLength(4);
    expect(store.state.activePartId).toBe(id);

    expect(store.undo()).toBe(true);
    expect(store.state.project.parts).toHaveLength(3);
    // The active part cannot point at a part that no longer exists.
    expect(store.partById(store.state.activePartId)).toBeDefined();

    expect(store.redo()).toBe(true);
    expect(store.state.project.parts).toHaveLength(4);
    expect(store.removePart(id).ok).toBe(true);
    expect(store.state.project.parts).toHaveLength(3);
    expect(store.undo()).toBe(true);
    expect(store.state.project.parts).toHaveLength(4);
  });

  it('undoes part ordering changes', () => {
    const store = new EditorStore();
    const before = store.partsInOrder.map((part) => part.id);
    store.movePart(FAR_WING_PART_ID, 1);
    expect(store.partsInOrder.map((part) => part.id)).not.toEqual(before);
    expect(store.undo()).toBe(true);
    expect(store.partsInOrder.map((part) => part.id)).toEqual(before);
  });

  it('leaves no history entry behind for a refused reorder', () => {
    const store = new EditorStore();
    const undoCountBefore = store.canUndo;
    expect(store.movePart(NEAR_WING_PART_ID, 1)).toBe(false);
    expect(store.canUndo).toBe(undoCountBefore);
    // A step the user never saw must not become redoable either.
    expect(store.canRedo).toBe(false);
  });

  it('leaves no redoable step behind for a refused part deletion', () => {
    const store = new EditorStore();
    const node = store.addNodeAt({ x: 0.5, y: 0.5 });
    expect(store.removePart(BODY_PART_ID).ok).toBe(false);
    expect(store.canRedo).toBe(false);
    expect(store.nodeById(node)).toBeDefined();
    expect(store.state.project.parts).toHaveLength(3);
  });

  it('undoes runtime render toggles but not editor display state', () => {
    const store = new EditorStore();
    store.setPartRenderEnabled(FAR_WING_PART_ID, false);
    expect(store.partById(FAR_WING_PART_ID)!.renderEnabled).toBe(false);
    expect(store.undo()).toBe(true);
    expect(store.partById(FAR_WING_PART_ID)!.renderEnabled).toBe(true);

    // Hiding is editor-only: nothing to undo.
    store.updatePartDisplay(FAR_WING_PART_ID, { hidden: true });
    expect(store.canUndo).toBe(false);
  });

  it('keeps runtime visibility independent of the editor hide flag', () => {
    const store = new EditorStore();
    store.updatePartDisplay(FAR_WING_PART_ID, { hidden: true });
    // Editor-hidden, but still exported and still rendered in Preview.
    expect(store.partStateOf(FAR_WING_PART_ID).visible).toBe(false);
    expect(store.partById(FAR_WING_PART_ID)!.renderEnabled).toBe(true);
    expect(renderablePartsInOrder(store.state.project).map((part) => part.id)).toContain(
      FAR_WING_PART_ID,
    );
  });

  it('survives a full export and import round trip with parts and occluders', () => {
    const store = new EditorStore();
    store.setActivePart(FAR_WING_PART_ID);
    const w1 = store.addNodeAt({ x: 0.1, y: 0.1 });
    const w2 = store.addNodeAt({ x: 0.3, y: 0.1 });
    store.addEdgeBetween(w1, w2);
    store.setActivePart(BODY_PART_ID);
    const b1 = store.addNodeAt({ x: 0.4, y: 0.4 });
    const b2 = store.addNodeAt({ x: 0.6, y: 0.4 });
    const b3 = store.addNodeAt({ x: 0.5, y: 0.7 });
    store.addOccluder([b1, b2, b3], {
      name: 'Body silhouette',
      ownerPartId: BODY_PART_ID,
      targetPartIds: [FAR_WING_PART_ID],
    });
    store.updateSettings({ interpolation: 'linear', tension: 0.25 });

    const before = store.state.project;
    const result = parseProject(serializeProject(before));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.project.parts).toEqual(before.parts);
    expect(result.project.occluders).toEqual(before.occluders);
    expect(result.project.nodes).toEqual(before.nodes);
    expect(result.project.edges).toEqual(before.edges);
    expect(result.project.settings.interpolation).toBe('linear');
    expect(result.project.settings.tension).toBe(0.25);
    // The far wing kept all of its geometry through the trip.
    expect(result.project.nodes.filter((node) => node.partId === FAR_WING_PART_ID)).toHaveLength(2);
  });
});
