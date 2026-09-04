// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimationPlayer } from '../src/runtime/AnimationPlayer.ts';
import { installCanvasEnvironment } from './support/canvasEnvironment.ts';
import { createEmptyProject } from '../src/model/projectFactory.ts';
import { DEFAULT_PART_ID } from '../src/runtime/parts.ts';
import type { AnimationProject } from '../src/runtime/types.ts';

/**
 * The player driven directly, with no store anywhere: this is the shape an
 * embedding site meets. Backed by node-canvas so the real drawing code runs.
 */
beforeAll(() => installCanvasEnvironment());

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
  const canvas = document.createElement('canvas');
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

  it('never runs backwards on a frame stamped before it started', () => {
    // requestAnimationFrame hands over the frame's own start time, which can
    // predate the performance.now() taken when play() was called. Left alone
    // that makes the first delta negative and the playhead goes past zero.
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1 as unknown as number);
    vi.spyOn(performance, 'now').mockReturnValue(500);

    const { player } = mount();
    player.play();
    raf.mock.calls.at(-1)![0](480);

    expect(player.time).toBe(0);
    expect(Object.is(player.time, -0)).toBe(false);
    vi.restoreAllMocks();
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
