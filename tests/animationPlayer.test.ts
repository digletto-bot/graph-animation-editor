// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from 'canvas';
import { AnimationPlayer } from '../src/runtime/AnimationPlayer.ts';
import { createEmptyProject } from '../src/model/projectFactory.ts';
import { DEFAULT_PART_ID } from '../src/runtime/parts.ts';
import type { AnimationProject } from '../src/runtime/types.ts';

/**
 * The player driven directly, with no store anywhere: this is the shape an
 * embedding site meets. Backed by node-canvas so the real drawing code runs.
 */
beforeAll(() => {
  const proto = window.HTMLCanvasElement.prototype as unknown as {
    getContext: (type: string) => unknown;
  };
  proto.getContext = function getContext(this: HTMLCanvasElement, type: string) {
    const backing = createCanvas(this.width || 300, this.height || 150);
    return type === '2d' ? backing.getContext('2d') : null;
  };

  // The renderer composites its offscreen part layers with drawImage, and
  // node-canvas refuses a jsdom element as the source. Offscreen canvases are
  // therefore real node-canvas surfaces; the mount target below stays a DOM
  // element, which only ever plays the destination.
  const createElement = document.createElement.bind(document);
  document.createElement = ((tag: string, ...rest: unknown[]) =>
    tag === 'canvas'
      ? (createCanvas(300, 150) as unknown as HTMLCanvasElement)
      : createElement(tag as 'div', ...(rest as []))) as typeof document.createElement;
  hostCanvas = () => createElement('canvas');
  window.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  window.HTMLElement.prototype.getBoundingClientRect = function bounds() {
    return { x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => ({}) };
  } as unknown as () => DOMRect;
});

/** A real DOM canvas, made before createElement was redirected above. */
let hostCanvas: () => HTMLCanvasElement = () => document.createElement('canvas');

beforeEach(() => {
  document.body.innerHTML = '';
});

/** A two-pose project: one node crossing the board over two seconds. */
function project(): AnimationProject {
  const built = createEmptyProject();
  built.settings.duration = 2;
  built.settings.loop = false;
  built.nodes.push({
    id: 'n1',
    name: 'n1',
    partId: DEFAULT_PART_ID,
    width: 2,
    brightness: 1,
  });
  built.poses[0]!.positions = { n1: { x: 0.1, y: 0.5 } };
  built.poses.push({ id: 'p2', name: 'Pose 2', time: 2, positions: { n1: { x: 0.9, y: 0.5 } } });
  return built;
}

function mount(built = project()) {
  const host = document.createElement('div');
  const canvas = hostCanvas();
  host.appendChild(canvas);
  document.body.appendChild(host);
  return { player: new AnimationPlayer(canvas, built), canvas, project: built };
}

describe('the player on its own', () => {
  it('mounts on a canvas and draws a frame without throwing', () => {
    const { player } = mount();
    player.resize();
    player.renderOnce();
    expect(player.time).toBe(0);
    expect(player.playing).toBe(false);
  });

  it('seeks within the project and clamps to its duration', () => {
    const { player } = mount();
    player.seek(1.25);
    expect(player.time).toBeCloseTo(1.25, 4);
    player.seek(99);
    expect(player.time).toBeCloseTo(2, 4);
    player.seek(-5);
    expect(player.time).toBe(0);
  });

  it('advances its own clock across frames and reports each one', () => {
    const frames: Array<[number, boolean]> = [];
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1 as unknown as number);
    const now = vi.spyOn(performance, 'now');

    const { player } = mount();
    player.onTime = (time, finished) => frames.push([time, finished]);
    now.mockReturnValue(0);
    player.play();

    // Drive the loop by hand: whatever rAF was handed, called with a timestamp.
    const tick = (at: number) => raf.mock.calls.at(-1)![0](at);
    tick(100);
    tick(200);

    expect(frames.map(([time]) => time)).toEqual([0.1, 0.2]);
    expect(player.time).toBeCloseTo(0.2, 4);
    raf.mockRestore();
    now.mockRestore();
  });

  it('stops itself at the end of a project that does not loop', () => {
    const frames: Array<[number, boolean]> = [];
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1 as unknown as number);
    vi.spyOn(performance, 'now').mockReturnValue(0);

    const { player } = mount();
    player.onTime = (time, finished) => frames.push([time, finished]);
    player.play();
    // A frame is capped at 0.1s of animation however long the gap was, so a
    // two second project needs twenty of them.
    for (let frame = 1; frame <= 25; frame += 1) {
      raf.mock.calls.at(-1)![0](frame * 100);
    }

    expect(player.playing).toBe(false);
    expect(player.time).toBeCloseTo(2, 4);
    expect(frames.at(-1)![1]).toBe(true);
    vi.restoreAllMocks();
  });

  it('takes a replacement project without being rebuilt', () => {
    const { player } = mount();
    const replacement = project();
    replacement.settings.duration = 10;
    player.setProject(replacement);
    player.seek(8);
    expect(player.time).toBeCloseTo(8, 4);
  });

  it('exports the current frame as a PNG data URL', () => {
    const { player } = mount();
    player.resize();
    expect(player.exportDataUrl().startsWith('data:image/png')).toBe(true);
  });
});
