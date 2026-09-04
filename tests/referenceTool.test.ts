// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type Konva from 'konva';
import { ReferenceTool } from '../src/editor/tools/ReferenceTool.ts';
import { EditorStore } from '../src/state/EditorStore.ts';
import type { EditorContext, PointerInfo } from '../src/editor/types.ts';
import type { Point } from '../src/model/types.ts';

/**
 * Driven through the EditorContext seam, the same one the tools were built
 * against. The reference tool touches no Konva shapes at all — it only reads
 * the pointer and writes the store — so no canvas backend is needed.
 */
function harness() {
  const store = new EditorStore();
  const cursors: string[] = [];
  const ctx = {
    store,
    setCursor: (cursor: string) => cursors.push(cursor),
    overlay: { add: () => undefined, batchDraw: () => undefined } as unknown as Konva.Layer,
    displayPositions: () => store.activePose.positions,
    screenToNormalized: (point: Point) => point,
    normalizedToScreen: (point: Point) => point,
    snap: (position: Point) => ({ position, indicator: null, targetNodeId: null }),
    showSnapIndicator: () => {},
    syncPositions: () => {},
    refreshOverlay: () => {},
    nodeAtScreenPoint: () => null,
    stage: null as unknown as Konva.Stage,
  } as unknown as EditorContext;

  store.updateReference({ src: 'data:image/png;base64,AAAA', name: 'ref.png', x: 0, y: 0 });
  return { store, ctx, cursors, tool: new ReferenceTool(ctx) };
}

function at(x: number, y: number): PointerInfo {
  return {
    screen: { x, y },
    normalized: { x: 0, y: 0 },
    target: null,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    button: 0,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('dragging the reference image', () => {
  it('moves it by the pointer delta', () => {
    const { store, tool } = harness();
    tool.onPointerDown(at(100, 100));
    tool.onPointerMove(at(140, 130));
    tool.onPointerUp();

    expect(store.state.reference.x).toBeCloseTo(40, 4);
    expect(store.state.reference.y).toBeCloseTo(30, 4);
  });

  it('converts the delta out of screen space, so zoom does not multiply the move', () => {
    const { store, tool } = harness();
    store.setCamera({ x: 0, y: 0, scale: 2 });
    tool.onPointerDown(at(0, 0));
    tool.onPointerMove(at(100, 0));
    tool.onPointerUp();

    // 100 screen pixels at 2x zoom is 50 project pixels.
    expect(store.state.reference.x).toBeCloseTo(50, 4);
  });

  it('is one undo step for the whole drag', () => {
    const { store, tool } = harness();
    tool.onPointerDown(at(0, 0));
    for (const x of [10, 20, 30, 40]) tool.onPointerMove(at(x, 0));
    tool.onPointerUp();
    expect(store.state.reference.x).toBeCloseTo(40, 4);

    expect(store.undo()).toBe(true);
    expect(store.state.reference.x).toBeCloseTo(0, 4);
  });

  it('tracks from where the drag began, not from the last move', () => {
    const { store, tool } = harness();
    store.updateReference({ x: 7, y: 3 });
    tool.onPointerDown(at(50, 50));
    tool.onPointerMove(at(60, 60));
    tool.onPointerMove(at(55, 55));
    tool.onPointerUp();

    expect(store.state.reference.x).toBeCloseTo(12, 4);
    expect(store.state.reference.y).toBeCloseTo(8, 4);
  });

  it('restores the original position on Escape', () => {
    const { store, tool } = harness();
    tool.onPointerDown(at(0, 0));
    tool.onPointerMove(at(90, 90));
    expect(tool.onEscape()).toBe(true);
    expect(store.state.reference.x).toBeCloseTo(0, 4);
    expect(store.state.reference.y).toBeCloseTo(0, 4);
  });

  it('ignores Escape when no drag is in flight', () => {
    const { tool } = harness();
    expect(tool.onEscape()).toBe(false);
  });

  it('ignores a non-primary button', () => {
    const { store, tool } = harness();
    tool.onPointerDown({ ...at(0, 0), button: 2 });
    tool.onPointerMove(at(80, 80));
    expect(store.state.reference.x).toBeCloseTo(0, 4);
  });
});

describe('with no reference loaded', () => {
  it('refuses the drag and says why', () => {
    const { store, tool } = harness();
    store.updateReference({ src: null });
    tool.onPointerDown(at(0, 0));
    tool.onPointerMove(at(50, 50));

    expect(store.state.reference.x).toBeCloseTo(0, 4);
    expect(store.state.status?.tone).toBe('error');
    expect(store.hasPendingTransaction).toBe(false);
  });
});

describe('leaving the tool', () => {
  it('abandons a drag left in flight rather than half-committing it', () => {
    const { store, tool } = harness();
    tool.onPointerDown(at(0, 0));
    tool.onPointerMove(at(70, 0));
    tool.deactivate();

    expect(store.hasPendingTransaction).toBe(false);
    expect(store.state.reference.x).toBeCloseTo(0, 4);
  });
});
