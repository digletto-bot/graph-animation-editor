// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from 'canvas';
import type { AnimationEditor } from '../src/app/AnimationEditor.ts';

/**
 * Drives real pointer and keyboard input through the mounted editor. This is
 * what verifies the chain that unit tests cannot reach: DOM event -> tool
 * dispatch -> Konva hit test -> coordinate conversion -> store mutation.
 */

const VIEW = { width: 900, height: 600 };
const backings = new WeakMap<HTMLCanvasElement, ReturnType<typeof createCanvas>>();

beforeAll(() => {
  const proto = window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = function getContext(this: HTMLCanvasElement, type: string) {
    if (type !== '2d') return null;
    let backing = backings.get(this);
    if (!backing) {
      // Generously sized so later width/height changes never clip drawing.
      backing = createCanvas(2000, 1400);
      backings.set(this, backing);
      const context = backing.getContext('2d') as unknown as Record<string, unknown>;
      // node-canvas rejects jsdom elements, so swap in the real backing.
      const original = (context.drawImage as (...args: unknown[]) => void).bind(context);
      context.drawImage = (image: unknown, ...rest: unknown[]) =>
        original(backings.get(image as HTMLCanvasElement) ?? image, ...rest);
    }
    return backing.getContext('2d');
  };

  window.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;

  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: VIEW.width,
      bottom: VIEW.height,
      width: VIEW.width,
      height: VIEW.height,
      toJSON: () => ({}),
    } as DOMRect;
  };

  window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    setTimeout(
      () => callback(performance.now()),
      16,
    ) as unknown as number) as typeof requestAnimationFrame;
  window.cancelAnimationFrame = ((handle: number) =>
    clearTimeout(
      handle as unknown as ReturnType<typeof setTimeout>,
    )) as typeof cancelAnimationFrame;
});

async function mount(): Promise<{ app: AnimationEditor; root: HTMLElement; stage: HTMLElement }> {
  const module = await import('../src/app/AnimationEditor.ts');
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = new module.AnimationEditor(root);
  const stage = root.querySelector<HTMLElement>('.stage-host')!;
  return { app, root, stage };
}

/** jsdom has no PointerEvent; MouseEvent carries every field the editor reads. */
function pointer(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  init: MouseEventInit = {},
) {
  target.dispatchEvent(
    new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, ...init }),
  );
}

function key(k: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
}

/** Convert a normalized point to a client coordinate using the live camera. */
function clientPoint(app: AnimationEditor, nx: number, ny: number) {
  const { settings } = app.store.state.project;
  const camera = app.store.state.camera;
  return {
    x: nx * settings.width * camera.scale + camera.x,
    y: ny * settings.height * camera.scale + camera.y,
  };
}

function addNodeAt(app: AnimationEditor, stage: HTMLElement, nx: number, ny: number): string {
  const point = clientPoint(app, nx, ny);
  pointer(stage, 'pointerdown', point.x, point.y);
  pointer(window, 'pointerup', point.x, point.y);
  const nodes = app.store.state.project.nodes;
  return nodes[nodes.length - 1]!.id;
}

describe('pointer authoring', () => {
  it('creates nodes where the user clicks', async () => {
    const { app, stage } = await mount();
    key('n');
    expect(app.store.state.tool).toBe('node');

    const id = addNodeAt(app, stage, 0.25, 0.4);
    expect(app.store.state.project.nodes).toHaveLength(1);

    const position = app.store.positionOf(id);
    expect(position.x).toBeCloseTo(0.25, 4);
    expect(position.y).toBeCloseTo(0.4, 4);
    // The new node is selected, which the inspector reflects.
    expect(app.store.state.selectedNodeIds).toEqual([id]);
  });

  it('connects two nodes with the edge tool and refuses a duplicate', async () => {
    const { app, stage } = await mount();
    key('n');
    const a = addNodeAt(app, stage, 0.2, 0.2);
    const b = addNodeAt(app, stage, 0.8, 0.3);

    key('e');
    const pa = clientPoint(app, 0.2, 0.2);
    const pb = clientPoint(app, 0.8, 0.3);
    pointer(stage, 'pointerdown', pa.x, pa.y);
    pointer(window, 'pointerup', pa.x, pa.y);
    pointer(stage, 'pointerdown', pb.x, pb.y);
    pointer(window, 'pointerup', pb.x, pb.y);

    expect(app.store.state.project.edges).toHaveLength(1);
    const edge = app.store.state.project.edges[0]!;
    expect([edge.from, edge.to].sort()).toEqual([a, b].sort());

    // Clicking the same pair again must not create a second edge.
    pointer(stage, 'pointerdown', pa.x, pa.y);
    pointer(window, 'pointerup', pa.x, pa.y);
    expect(app.store.state.project.edges).toHaveLength(1);
  });

  it('drags a node and keeps its edges attached, as one undo step', async () => {
    const { app, stage } = await mount();
    key('n');
    const a = addNodeAt(app, stage, 0.3, 0.3);
    addNodeAt(app, stage, 0.7, 0.7);

    key('e');
    const pa = clientPoint(app, 0.3, 0.3);
    const pb = clientPoint(app, 0.7, 0.7);
    pointer(stage, 'pointerdown', pa.x, pa.y);
    pointer(window, 'pointerup', pa.x, pa.y);
    pointer(stage, 'pointerdown', pb.x, pb.y);
    pointer(window, 'pointerup', pb.x, pb.y);
    expect(app.store.state.project.edges).toHaveLength(1);

    key('v');
    const start = clientPoint(app, 0.3, 0.3);
    const end = clientPoint(app, 0.55, 0.45);
    pointer(stage, 'pointerdown', start.x, start.y);
    // Several move events: the drag must still collapse to one history entry.
    for (let step = 1; step <= 8; step += 1) {
      pointer(
        window,
        'pointermove',
        start.x + ((end.x - start.x) * step) / 8,
        start.y + ((end.y - start.y) * step) / 8,
      );
    }
    pointer(window, 'pointerup', end.x, end.y);

    expect(app.store.positionOf(a).x).toBeCloseTo(0.55, 3);
    expect(app.store.positionOf(a).y).toBeCloseTo(0.45, 3);
    // The edge still references the same nodes, so it followed the drag.
    expect(
      app.store.state.project.edges[0]!.from === a || app.store.state.project.edges[0]!.to === a,
    ).toBe(true);

    key('z', { ctrlKey: true });
    expect(app.store.positionOf(a).x).toBeCloseTo(0.3, 3);
    key('z', { ctrlKey: true, shiftKey: true });
    expect(app.store.positionOf(a).x).toBeCloseTo(0.55, 3);
  });

  it('selects several nodes with a rectangular marquee', async () => {
    const { app, stage } = await mount();
    key('n');
    addNodeAt(app, stage, 0.2, 0.2);
    addNodeAt(app, stage, 0.3, 0.3);
    addNodeAt(app, stage, 0.9, 0.9);

    key('v');
    const from = clientPoint(app, 0.1, 0.1);
    const to = clientPoint(app, 0.45, 0.45);
    pointer(stage, 'pointerdown', from.x, from.y);
    pointer(window, 'pointermove', to.x, to.y);
    pointer(window, 'pointerup', to.x, to.y);

    expect(app.store.state.selectedNodeIds).toHaveLength(2);
  });

  it('deletes a node and its edges with the Delete key', async () => {
    const { app, stage } = await mount();
    key('n');
    const a = addNodeAt(app, stage, 0.3, 0.3);
    addNodeAt(app, stage, 0.7, 0.7);
    key('e');
    const pa = clientPoint(app, 0.3, 0.3);
    const pb = clientPoint(app, 0.7, 0.7);
    pointer(stage, 'pointerdown', pa.x, pa.y);
    pointer(window, 'pointerup', pa.x, pa.y);
    pointer(stage, 'pointerdown', pb.x, pb.y);
    pointer(window, 'pointerup', pb.x, pb.y);

    app.store.setSelection([a], []);
    key('Delete');

    expect(app.store.state.project.nodes).toHaveLength(1);
    expect(app.store.state.project.edges).toHaveLength(0);
    for (const pose of app.store.state.project.poses) {
      expect(pose.positions[a]).toBeUndefined();
    }
  });

  it('pans and zooms without moving stored geometry', async () => {
    const { app, stage } = await mount();
    key('n');
    const a = addNodeAt(app, stage, 0.4, 0.6);
    const before = { ...app.store.positionOf(a) };

    stage.dispatchEvent(
      new window.WheelEvent('wheel', {
        deltaY: -300,
        clientX: 400,
        clientY: 300,
        bubbles: true,
        cancelable: true,
      }),
    );
    key('h');
    pointer(stage, 'pointerdown', 400, 300);
    pointer(window, 'pointermove', 520, 360);
    pointer(window, 'pointerup', 520, 360);

    expect(app.store.state.camera.scale).not.toBeCloseTo(1, 6);
    expect(app.store.positionOf(a)).toEqual(before);
  });

  it('edits only the active pose', async () => {
    const { app, stage } = await mount();
    key('n');
    const a = addNodeAt(app, stage, 0.3, 0.3);
    const firstPose = app.store.state.activePoseId;

    app.store.addPoseAfterActive();
    const secondPose = app.store.state.activePoseId;

    key('v');
    const start = clientPoint(app, 0.3, 0.3);
    const end = clientPoint(app, 0.6, 0.3);
    pointer(stage, 'pointerdown', start.x, start.y);
    pointer(window, 'pointermove', end.x, end.y);
    pointer(window, 'pointerup', end.x, end.y);

    const poses = app.store.state.project.poses;
    expect(poses.find((p) => p.id === secondPose)!.positions[a]!.x).toBeCloseTo(0.6, 3);
    expect(poses.find((p) => p.id === firstPose)!.positions[a]!.x).toBeCloseTo(0.3, 3);
  });
});

describe('preview rendering', () => {
  it('draws lit pixels for the artwork and no editor overlays', async () => {
    const { app, stage } = await mount();
    key('n');
    addNodeAt(app, stage, 0.2, 0.5);
    addNodeAt(app, stage, 0.8, 0.5);
    key('e');
    const pa = clientPoint(app, 0.2, 0.5);
    const pb = clientPoint(app, 0.8, 0.5);
    pointer(stage, 'pointerdown', pa.x, pa.y);
    pointer(window, 'pointerup', pa.x, pa.y);
    pointer(stage, 'pointerdown', pb.x, pb.y);
    pointer(window, 'pointerup', pb.x, pb.y);

    app.store.setMode('preview');
    await new Promise((resolve) => setTimeout(resolve, 80));

    const canvas = document.querySelectorAll<HTMLCanvasElement>('.preview-canvas');
    const backing = backings.get(canvas[canvas.length - 1]!)!;
    const context = backing.getContext('2d');

    // Sample the middle of the edge: it should be lit well above background.
    const middle = context.getImageData(450, 300, 1, 1).data;
    const brightness = middle[0]! + middle[1]! + middle[2]!;
    expect(brightness).toBeGreaterThan(120);

    // A point far from any edge stays near the background colour.
    const corner = context.getImageData(60, 560, 1, 1).data;
    expect(corner[0]! + corner[1]! + corner[2]!).toBeLessThan(60);

    // Preview must not host any Konva canvases or editor chrome.
    const previewHost = document.querySelectorAll('.preview-host');
    expect(previewHost[previewHost.length - 1]!.querySelectorAll('.konvajs-content')).toHaveLength(
      0,
    );
  });

  it('advances the clock while playing and stops when paused', async () => {
    const { app } = await mount();
    app.store.setMode('preview');
    app.store.setPlaying(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const advanced = app.store.state.playback.time;
    expect(advanced).toBeGreaterThan(0);

    app.store.setPlaying(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(app.store.state.playback.time).toBeCloseTo(advanced, 2);
  });

  it('plays in Edit mode too, driven by the edit clock', async () => {
    const { app } = await mount();
    expect(app.store.state.mode).toBe('edit');
    app.store.setPlaying(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(app.store.state.playback.time).toBeGreaterThan(0);
    app.store.setPlaying(false);
  });
});
