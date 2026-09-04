// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnimationPlayer } from '../src/runtime/AnimationPlayer.ts';
import { installCanvasEnvironment } from './support/canvasEnvironment.ts';
import { createEmptyProject } from '../src/model/projectFactory.ts';
import { joinColor, splitColor } from '../src/utils/color.ts';
import type { AnimationProject } from '../src/runtime/types.ts';

/**
 * A translucent background, from the two sides that have to agree on it: the
 * inspector, which edits a colour as a swatch plus an opacity, and the
 * renderer, which has to leave the canvas actually see-through.
 */
beforeAll(() => installCanvasEnvironment());

beforeEach(() => {
  document.body.innerHTML = '';
});

function mount(background: string) {
  const project: AnimationProject = createEmptyProject();
  project.settings.backgroundColor = background;
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  const player = new AnimationPlayer(canvas, project);
  player.resize();
  player.renderOnce();
  return { player, canvas };
}

/** The background is painted across the whole canvas, so any pixel will do. */
function cornerPixel(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const context = canvas.getContext('2d')!;
  return context.getImageData(2, 2, 1, 1).data;
}

describe('splitting and rejoining a colour', () => {
  it('reads a plain hex colour as fully opaque', () => {
    expect(splitColor('#05060a')).toEqual({ hex: '#05060a', alpha: 1 });
  });

  it('reads the alpha out of an 8-digit hex colour', () => {
    const { hex, alpha } = splitColor('#05060a80');
    expect(hex).toBe('#05060a');
    expect(alpha).toBeCloseTo(0.502, 2);
  });

  it('expands shorthand, with and without alpha', () => {
    expect(splitColor('#abc').hex).toBe('#aabbcc');
    expect(splitColor('#abcf').alpha).toBe(1);
    expect(splitColor('#abc0').alpha).toBe(0);
  });

  it('treats anything it cannot read as opaque, without inventing a colour', () => {
    // A hand-edited file may hold rgba() or a named colour. It still renders —
    // the renderer hands the string to canvas — it just reports as opaque.
    expect(splitColor('rgba(0,0,0,0.5)', '#123456')).toEqual({ hex: '#123456', alpha: 1 });
  });

  it('leaves an opaque colour in its original 6-digit form', () => {
    // So a project that never touches transparency serialises as it always did.
    expect(joinColor('#05060a', 1)).toBe('#05060a');
  });

  it('appends the alpha byte below full opacity, clamping out of range', () => {
    expect(joinColor('#05060a', 0)).toBe('#05060a00');
    expect(joinColor('#05060a', 0.5)).toBe('#05060a80');
    expect(joinColor('#05060a', -1)).toBe('#05060a00');
    expect(joinColor('#05060a', 2)).toBe('#05060a');
  });

  it('round-trips whatever the inspector writes', () => {
    const written = joinColor('#ff8800', 0.4);
    const read = splitColor(written);
    expect(read.hex).toBe('#ff8800');
    expect(read.alpha).toBeCloseTo(0.4, 2);
  });
});

describe('the renderer with a translucent background', () => {
  it('leaves the canvas partly transparent', () => {
    const { canvas } = mount('#ff000080');
    const [red, , , alpha] = cornerPixel(canvas);
    expect(red).toBeGreaterThan(0);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(255);
  });

  it('leaves nothing at all behind a fully transparent background', () => {
    const { canvas } = mount('#05060a00');
    expect(cornerPixel(canvas)[3]).toBe(0);
  });

  it('still paints an opaque background solid', () => {
    const { canvas } = mount('#05060a');
    const [red, green, blue, alpha] = cornerPixel(canvas);
    expect([red, green, blue]).toEqual([5, 6, 10]);
    expect(alpha).toBe(255);
  });

  it('does not accumulate the previous frame under a translucent background', () => {
    // The whole point of clearing first: two draws of a half-opaque background
    // must not stack into an opaque one.
    const { player, canvas } = mount('#ff000080');
    const first = cornerPixel(canvas)[3];
    player.renderOnce();
    player.renderOnce();
    expect(cornerPixel(canvas)[3]).toBe(first);
  });
});
