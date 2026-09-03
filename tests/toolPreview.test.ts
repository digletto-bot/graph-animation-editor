// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import type Konva from 'konva';
import { OccluderTool } from '../src/editor/tools/OccluderTool.ts';
import { EdgeTool } from '../src/editor/tools/EdgeTool.ts';
import { EditorStore } from '../src/state/EditorStore.ts';
import type { EditorContext, PointerInfo } from '../src/editor/types.ts';
import type { CameraState, NodePosition, Point } from '../src/model/types.ts';
import { normalizedToStage } from '../src/utils/coordinates.ts';

/**
 * Tool previews are drawn into the overlay in *screen* coordinates, so they go
 * stale the moment the camera moves. These drive the tools through the
 * EditorContext seam — the same seam the tools were built against — with a stub
 * overlay that records the shapes, so no Konva *stage* is needed.
 *
 * Konva shapes still need a 2D context at construction, so jsdom is backed by
 * node-canvas exactly as `mount.test.ts` does it. That binding is an optional
 * native dependency; where it is not built these cases skip rather than run
 * against a hand-rolled canvas that could pass while a browser fails.
 */
type CanvasFactory = (width: number, height: number) => HTMLCanvasElement;

async function loadCanvasFactory(): Promise<CanvasFactory | null> {
  try {
    const nodeCanvas = (await import('canvas')) as unknown as { createCanvas: CanvasFactory };
    const probe = nodeCanvas.createCanvas(1, 1);
    if (!probe.getContext('2d')) return null;
    return nodeCanvas.createCanvas;
  } catch {
    return null;
  }
}

const createCanvas = await loadCanvasFactory();
const describeCanvas = createCanvas ? describe : describe.skip;

beforeAll(() => {
  if (!createCanvas) return;
  const proto = window.HTMLCanvasElement.prototype as unknown as {
    getContext: (type: string) => unknown;
  };
  proto.getContext = function getContext(this: HTMLCanvasElement, type: string) {
    const backing = createCanvas(this.width || 300, this.height || 150);
    return type === '2d' ? backing.getContext('2d') : null;
  };
});

function harness() {
  const store = new EditorStore();
  const a = store.addNodeAt({ x: 0.2, y: 0.2 });
  const b = store.addNodeAt({ x: 0.8, y: 0.2 });
  const c = store.addNodeAt({ x: 0.5, y: 0.8 });

  const camera: CameraState = { x: 0, y: 0, scale: 1 };
  const shapes: Konva.Node[] = [];
  const overlay = {
    add: (...added: Konva.Node[]) => {
      shapes.push(...added);
      return overlay;
    },
    batchDraw: () => overlay,
  } as unknown as Konva.Layer;

  const toScreen = (position: NodePosition): Point =>
    normalizedToStage(position, store.state.project.settings, camera);

  const ctx: EditorContext = {
    store,
    stage: null as unknown as Konva.Stage,
    overlay,
    displayPositions: () => store.activePose.positions,
    screenToNormalized: (point) => point,
    normalizedToScreen: toScreen,
    snap: (position) => ({ position, indicator: null, targetNodeId: null }),
    showSnapIndicator: () => {},
    syncPositions: () => {},
    refreshOverlay: () => {},
    nodeAtScreenPoint: () => null,
    setCursor: () => {},
  };

  return { store, ctx, camera, shapes, a, b, c, toScreen };
}

function clickNode(nodeId: string, screen: Point): PointerInfo {
  return {
    screen,
    normalized: { x: 0, y: 0 },
    target: { kind: 'node', id: nodeId },
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    button: 0,
  };
}

describeCanvas('occluder preview follows the camera', () => {
  it('re-projects the traced polygon after a pan', () => {
    const { ctx, camera, shapes, a, b, c, toScreen } = harness();
    const tool = new OccluderTool(ctx);
    const polygon = shapes[0] as Konva.Line;

    tool.onPointerDown(clickNode(a, toScreen({ x: 0.2, y: 0.2 })));
    tool.onPointerDown(clickNode(b, toScreen({ x: 0.8, y: 0.2 })));
    tool.onPointerDown(clickNode(c, toScreen({ x: 0.5, y: 0.8 })));

    const before = [...polygon.points()];
    expect(before).toHaveLength(6);

    // Pan the view. Without a sync the polygon would keep its old screen points.
    camera.x += 100;
    camera.y += 40;
    tool.sync();

    const after = polygon.points();
    expect(after).toHaveLength(6);
    for (let i = 0; i < after.length; i += 2) {
      expect(after[i]).toBeCloseTo(before[i]! + 100, 6);
      expect(after[i + 1]).toBeCloseTo(before[i + 1]! + 40, 6);
    }
  });

  it('re-projects after a zoom, keeping the polygon on its nodes', () => {
    const { ctx, camera, shapes, a, b, c, toScreen } = harness();
    const tool = new OccluderTool(ctx);
    const polygon = shapes[0] as Konva.Line;

    tool.onPointerDown(clickNode(a, toScreen({ x: 0.2, y: 0.2 })));
    tool.onPointerDown(clickNode(b, toScreen({ x: 0.8, y: 0.2 })));
    tool.onPointerDown(clickNode(c, toScreen({ x: 0.5, y: 0.8 })));

    camera.scale = 2;
    tool.sync();

    // Each vertex must sit exactly where its node now projects.
    const expected = [
      toScreen({ x: 0.2, y: 0.2 }),
      toScreen({ x: 0.8, y: 0.2 }),
      toScreen({ x: 0.5, y: 0.8 }),
    ];
    const points = polygon.points();
    expected.forEach((point, index) => {
      expect(points[index * 2]).toBeCloseTo(point.x, 6);
      expect(points[index * 2 + 1]).toBeCloseTo(point.y, 6);
    });
  });

  it('keeps the vertex markers on the nodes too', () => {
    const { ctx, camera, shapes, a, b, c, toScreen } = harness();
    const tool = new OccluderTool(ctx);
    const markers = shapes[2] as Konva.Group;

    tool.onPointerDown(clickNode(a, toScreen({ x: 0.2, y: 0.2 })));
    tool.onPointerDown(clickNode(b, toScreen({ x: 0.8, y: 0.2 })));
    tool.onPointerDown(clickNode(c, toScreen({ x: 0.5, y: 0.8 })));

    camera.x -= 250;
    camera.scale = 0.5;
    tool.sync();

    const drawn = markers.getChildren();
    expect(drawn).toHaveLength(3);
    const first = toScreen({ x: 0.2, y: 0.2 });
    expect(drawn[0]!.x()).toBeCloseTo(first.x, 6);
    expect(drawn[0]!.y()).toBeCloseTo(first.y, 6);
  });

  it('does nothing while no boundary has been started', () => {
    const { ctx, shapes } = harness();
    const tool = new OccluderTool(ctx);
    const polygon = shapes[0] as Konva.Line;
    tool.sync();
    expect(polygon.visible()).toBe(false);
    expect(polygon.points()).toHaveLength(0);
  });

  it('hides the rubber band until the pointer has been seen', () => {
    const { ctx, shapes, a, toScreen } = harness();
    const tool = new OccluderTool(ctx);
    const rubberBand = shapes[1] as Konva.Line;

    tool.onPointerDown(clickNode(a, toScreen({ x: 0.2, y: 0.2 })));
    // A click does provide a pointer, so the band is live from the first node.
    expect(rubberBand.visible()).toBe(true);
  });
});

describeCanvas('edge preview follows the camera', () => {
  it('re-projects the pending edge from its start node', () => {
    const { ctx, camera, shapes, a, toScreen } = harness();
    const tool = new EdgeTool(ctx);
    const preview = shapes[0] as Konva.Line;

    const start = toScreen({ x: 0.2, y: 0.2 });
    tool.onPointerDown(clickNode(a, start));
    tool.onPointerMove(clickNode(a, { x: start.x + 30, y: start.y + 30 }));

    const before = [...preview.points()];
    expect(before[0]).toBeCloseTo(start.x, 6);

    camera.x += 75;
    tool.sync();

    const moved = toScreen({ x: 0.2, y: 0.2 });
    const after = preview.points();
    // The anchored end tracks its node; the cursor end stays under the cursor.
    expect(after[0]).toBeCloseTo(moved.x, 6);
    expect(after[2]).toBeCloseTo(before[2]!, 6);
  });

  it('stays hidden when no edge is in progress', () => {
    const { ctx, shapes } = harness();
    const tool = new EdgeTool(ctx);
    const preview = shapes[0] as Konva.Line;
    tool.sync();
    expect(preview.visible()).toBe(false);
  });
});
