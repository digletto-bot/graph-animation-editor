import { describe, expect, it } from 'vitest';
import {
  NODE_CORE_ALPHA,
  NODE_GLOW_ALPHA,
  nodeCoreAlpha,
  nodeDotRadius,
  nodeGlowAlpha,
  nodeGlowRadius,
} from '../src/preview/nodeDots.ts';
import {
  DEFAULT_NODE_BRIGHTNESS,
  DEFAULT_NODE_WIDTH,
  createEmptyProject,
  addNode,
} from '../src/model/projectFactory.ts';
import { NEAR_WING_PART_ID } from '../src/model/parts.ts';
import { layeredStore } from './support/layeredProject.ts';

describe('node dot geometry', () => {
  it('sizes the default node to the same radius the old dot used', () => {
    for (const strokeScale of [0.5, 1, 2, 3.7]) {
      expect(nodeDotRadius(DEFAULT_NODE_WIDTH, strokeScale)).toBeCloseTo(
        Math.max(1, 1.6 * strokeScale * 1.2),
        10,
      );
    }
  });

  it('draws the halo wider than the core, so the point reads as a glow', () => {
    expect(nodeGlowRadius(2, 1)).toBeGreaterThan(nodeDotRadius(2, 1));
  });

  it('runs both node passes at full strength for a default node', () => {
    expect(nodeCoreAlpha(DEFAULT_NODE_BRIGHTNESS)).toBeCloseTo(NODE_CORE_ALPHA, 10);
    expect(nodeGlowAlpha(DEFAULT_NODE_BRIGHTNESS)).toBeCloseTo(NODE_GLOW_ALPHA, 10);
  });

  it('draws nothing at all at brightness zero, which is how a node is hidden', () => {
    expect(nodeCoreAlpha(0)).toBe(0);
    expect(nodeGlowAlpha(0)).toBe(0);
  });

  it('scales the radius with the node width', () => {
    expect(nodeDotRadius(4, 2)).toBeGreaterThan(nodeDotRadius(2, 2));
    expect(nodeDotRadius(4, 2)).toBeCloseTo(nodeDotRadius(2, 2) * 2, 10);
  });

  it('never lets a dot shrink away to nothing', () => {
    expect(nodeDotRadius(0.2, 0.01)).toBe(1);
    expect(nodeDotRadius(0, 1)).toBe(1);
  });

  it('scales opacity with brightness and clamps to what canvas accepts', () => {
    expect(nodeCoreAlpha(0.5)).toBeCloseTo(NODE_CORE_ALPHA * 0.5, 10);
    expect(nodeGlowAlpha(0.5)).toBeCloseTo(NODE_GLOW_ALPHA * 0.5, 10);
    // Brightness runs to 2, which would overflow alpha without the clamp.
    expect(nodeCoreAlpha(2)).toBe(1);
    expect(nodeCoreAlpha(-1)).toBe(0);
    expect(nodeGlowAlpha(-1)).toBe(0);
  });

  it('survives values that are not numbers at all', () => {
    expect(nodeDotRadius(Number.NaN, 2)).toBe(1);
    expect(nodeCoreAlpha(Number.NaN)).toBe(NODE_CORE_ALPHA);
    expect(nodeGlowAlpha(Number.NaN)).toBe(NODE_GLOW_ALPHA);
  });
});

describe('new nodes carry appearance defaults', () => {
  it('sets them through the factory', () => {
    const project = createEmptyProject();
    const id = addNode(project, { x: 0.5, y: 0.5 }, project.poses[0]!.id);
    const node = project.nodes.find((entry) => entry.id === id)!;
    expect(node.width).toBe(DEFAULT_NODE_WIDTH);
    expect(node.brightness).toBe(DEFAULT_NODE_BRIGHTNESS);
  });

  it('sets them through the store', () => {
    const store = layeredStore();
    const id = store.addNodeAt({ x: 0.3, y: 0.3 });
    expect(store.nodeById(id)!.width).toBe(DEFAULT_NODE_WIDTH);
    expect(store.nodeById(id)!.brightness).toBe(DEFAULT_NODE_BRIGHTNESS);
  });
});

describe('editing node appearance in the store', () => {
  function seeded() {
    const store = layeredStore();
    const a = store.addNodeAt({ x: 0.2, y: 0.2 });
    const b = store.addNodeAt({ x: 0.6, y: 0.2 });
    return { store, a, b };
  }

  it('updates one node', () => {
    const { store, a } = seeded();
    store.updateNode(a, { width: 6, brightness: 0.3 });
    expect(store.nodeById(a)!.width).toBe(6);
    expect(store.nodeById(a)!.brightness).toBe(0.3);
  });

  it('updates many as a single undoable step', () => {
    const { store, a, b } = seeded();
    store.updateNodes([a, b], { width: 9 });
    expect(store.nodeById(a)!.width).toBe(9);
    expect(store.nodeById(b)!.width).toBe(9);

    expect(store.undo()).toBe(true);
    expect(store.nodeById(a)!.width).toBe(DEFAULT_NODE_WIDTH);
    expect(store.nodeById(b)!.width).toBe(DEFAULT_NODE_WIDTH);
  });

  it('skips nodes on a locked part', () => {
    const { store, a, b } = seeded();
    store.setNodePart(b, NEAR_WING_PART_ID);
    store.updatePartDisplay(NEAR_WING_PART_ID, { locked: true });
    store.updateNodes([a, b], { width: 8 });
    expect(store.nodeById(a)!.width).toBe(8);
    expect(store.nodeById(b)!.width).toBe(DEFAULT_NODE_WIDTH);
  });

  it('does nothing when nothing is editable', () => {
    const { store } = seeded();
    const undoableBefore = store.canUndo;
    store.updateNodes([], { width: 8 });
    expect(store.canUndo).toBe(undoableBefore);
  });
});
