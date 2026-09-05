// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installCanvasEnvironment } from './support/canvasEnvironment.ts';
import { AnimationEditor } from '../src/app/AnimationEditor.ts';
import { PoseSampler, samplePositions } from '../src/runtime/interpolation.ts';
import { cloneProject } from '../src/model/projectFactory.ts';
import type { AnimationProject } from '../src/runtime/types.ts';

/**
 * Replacing the whole document — an undo, a redo, an import — hands the runtime
 * new pose, node and edge objects under ids that are usually identical to the
 * old ones'. Every cache keyed on those ids has to notice anyway, or it goes on
 * answering from the project nobody is editing any more.
 */
beforeAll(() => installCanvasEnvironment());

function twoPoseProject(store: AnimationEditor['store']): string {
  const a = store.addNodeAt({ x: 0.2, y: 0.2 });
  const b = store.addNodeAt({ x: 0.6, y: 0.2 });
  store.addEdgeBetween(a, b);
  store.duplicateActivePose();
  return a;
}

describe('sampling a project that was swapped for an equivalent one', () => {
  it('follows the new copy, not the one it first saw', () => {
    const editor = mountEditor();
    const nodeId = twoPoseProject(editor.store);
    const original = editor.store.state.project;
    samplePositions(original, 0.5);

    // Same ids, same pose times: nothing in a key-based guard can tell these
    // apart from the originals.
    const swapped: AnimationProject = cloneProject(original);
    for (const pose of swapped.poses) pose.positions[nodeId] = { x: 0.9, y: 0.9 };

    const sampled = samplePositions(swapped, 0.5)[nodeId]!;
    expect(sampled.x).toBeCloseTo(0.9, 4);

    const sampler = new PoseSampler();
    sampler.sample(original, 0.5);
    sampler.sample(swapped, 0.5);
    const index = sampler.indexOf(nodeId);
    expect(sampler.positions[index * 2]).toBeCloseTo(0.9, 4);
  });
});

describe('the preview after an undo', () => {
  it('keeps showing edits made to the restored project', () => {
    const { store, canvas, drain } = mountEditor();
    const nodeId = twoPoseProject(store);

    // An undo anywhere in the session replaces the project object.
    store.setNodePosition(nodeId, { x: 0.3, y: 0.3 });
    store.undo();

    store.setMode('preview');
    drain(100);
    const before = pixels(canvas);

    store.setMode('edit');
    store.beginTransaction('Move nodes');
    store.setNodePositions({ [nodeId]: { x: 0.85, y: 0.85 } });
    store.endTransaction(['positions']);

    store.setMode('preview');
    drain(116);
    expect(pixels(canvas)).not.toBe(before);
  });

  it('keeps showing appearance edits made to the restored project', () => {
    const { store, canvas, drain } = mountEditor();
    const nodeId = twoPoseProject(store);

    store.setNodePosition(nodeId, { x: 0.3, y: 0.3 });
    store.undo();

    store.setMode('preview');
    drain(100);
    const before = pixels(canvas);

    store.updateNode(nodeId, { width: 12 });
    drain(116);
    expect(pixels(canvas)).not.toBe(before);
  });
});

/** Sum and first-moment of luminance: any pixel that moved shows up here. */
function pixels(canvas: HTMLCanvasElement): string {
  const context = canvas.getContext('2d')!;
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let total = 0;
  let moment = 0;
  for (let i = 0; i < data.length; i += 4) {
    const luminance = data[i]! + data[i + 1]! + data[i + 2]!;
    total += luminance;
    moment += luminance * i;
  }
  return `${total}:${moment}`;
}

/** The real app, with a hand-driven clock so frames can be stepped. */
function mountEditor() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );

  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.appendChild(root);
  const editor = new AnimationEditor(root);
  const canvas = document.querySelector<HTMLCanvasElement>('.preview-canvas')!;
  Object.defineProperty(canvas.parentElement!, 'getBoundingClientRect', {
    value: () => ({
      width: 400,
      height: 300,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 300,
    }),
  });

  return {
    store: editor.store,
    canvas,
    drain: (timestamp: number) => {
      for (const callback of frames.splice(0)) callback(timestamp);
    },
  };
}
