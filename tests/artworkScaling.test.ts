// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { EditorStore } from '../src/state/EditorStore.ts';
import { Inspector } from '../src/ui/Inspector.ts';
import {
  artworkRefitScale,
  createEmptyProject,
  refitArtworkToSize,
  scaleArtwork,
} from '../src/model/projectFactory.ts';
import type { AnimationProject, NodePosition } from '../src/model/types.ts';

beforeEach(() => {
  document.body.innerHTML = '';
});

/** A 1200x800 project whose single pose holds the given positions. */
function project(positions: Record<string, NodePosition>): AnimationProject {
  const built = createEmptyProject();
  built.settings.width = 1200;
  built.settings.height = 800;
  built.poses[0]!.positions = { ...positions };
  return built;
}

/** Where a stored position lands on the board, in artwork pixels. */
function pixels(built: AnimationProject, nodeId: string, poseIndex = 0) {
  const position = built.poses[poseIndex]!.positions[nodeId]!;
  return { x: position.x * built.settings.width, y: position.y * built.settings.height };
}

/** Width and height of the artwork's bounding box, in artwork pixels. */
function extent(built: AnimationProject) {
  const ids = Object.keys(built.poses[0]!.positions);
  const xs = ids.map((id) => pixels(built, id).x);
  const ys = ids.map((id) => pixels(built, id).y);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

describe('resizing the artboard without distorting the artwork', () => {
  it('keeps the drawing square when a 3:2 board becomes 1:1', () => {
    // The reported case: a bird drawn in 1200x800, wanted on a square board.
    const built = project({
      left: { x: 0, y: 0.5 },
      right: { x: 1, y: 0.5 },
      top: { x: 0.5, y: 0 },
      bottom: { x: 0.5, y: 1 },
    });
    const before = extent(built);
    expect(before).toEqual({ width: 1200, height: 800 });

    built.settings.width = 800;
    refitArtworkToSize(built, { width: 1200, height: 800 });

    const after = extent(built);
    // Same 3:2 shape as before, not squashed to the board's new 1:1.
    // Positions are stored to four decimals, so the ratio carries a little of
    // that rounding with it.
    expect(after.width / after.height).toBeCloseTo(before.width / before.height, 3);
    // And scaled down only as far as the narrower board required.
    expect(after.width).toBeCloseTo(800, 4);
    expect(after.height).toBeCloseTo(533.3, 1);
  });

  it('centres the artwork in the board it was refitted into', () => {
    const built = project({ a: { x: 0, y: 0 }, b: { x: 1, y: 1 } });
    built.settings.width = 800;
    refitArtworkToSize(built, { width: 1200, height: 800 });

    const a = pixels(built, 'a');
    const b = pixels(built, 'b');
    expect((a.x + b.x) / 2).toBeCloseTo(400, 4);
    expect((a.y + b.y) / 2).toBeCloseTo(400, 4);
  });

  it('keeps the artwork at its original pixel size when the board only grows', () => {
    const built = project({ a: { x: 0, y: 0.5 }, b: { x: 1, y: 0.5 } });
    built.settings.width = 1600;
    built.settings.height = 1000;
    refitArtworkToSize(built, { width: 1200, height: 800 });

    // 1200px wide before, 1200px wide after: the new room shows as margin
    // rather than stretching the drawing into it.
    expect(extent(built).width).toBeCloseTo(1200, 4);
    expect(artworkRefitScale({ width: 1200, height: 800 }, { width: 1600, height: 1000 })).toBe(1);
  });

  it('moves every pose by the same amount, so the animation still works', () => {
    const built = project({ a: { x: 0.2, y: 0.2 } });
    built.poses.push({
      id: 'p2',
      name: 'Pose 2',
      time: 1,
      positions: { a: { x: 0.8, y: 0.9 } },
    });

    built.settings.width = 800;
    refitArtworkToSize(built, { width: 1200, height: 800 });

    // Both poses moved through the identical mapping: x untouched, y pulled
    // toward the centre by two thirds.
    expect(built.poses[0]!.positions.a).toEqual({ x: 0.2, y: 0.3 });
    expect(built.poses[1]!.positions.a).toEqual({ x: 0.8, y: 0.7667 });
  });

  it('does nothing when the board did not actually change', () => {
    const built = project({ a: { x: 0.3, y: 0.7 } });
    refitArtworkToSize(built, { width: 1200, height: 800 });
    expect(built.poses[0]!.positions.a).toEqual({ x: 0.3, y: 0.7 });
  });
});

describe('scaling the whole animation', () => {
  it('scales every pose about the centre of the board', () => {
    const built = project({ a: { x: 0.25, y: 0.25 }, b: { x: 0.75, y: 0.75 } });
    scaleArtwork(built, 2);
    expect(built.poses[0]!.positions.a).toEqual({ x: 0, y: 0 });
    expect(built.poses[0]!.positions.b).toEqual({ x: 1, y: 1 });
  });

  it('keeps the proportions of what it scales', () => {
    const built = project({ a: { x: 0.2, y: 0.4 }, b: { x: 0.8, y: 0.6 } });
    const before = extent(built);
    scaleArtwork(built, 0.5);
    const after = extent(built);
    expect(after.width / before.width).toBeCloseTo(0.5, 4);
    expect(after.height / before.height).toBeCloseTo(0.5, 4);
  });

  it('lets a scale-up run past the frame rather than deforming the artwork', () => {
    // Clamping the nodes that overshoot would bend the drawing out of shape,
    // which is exactly what a uniform scale is for avoiding.
    const built = project({ a: { x: 0, y: 0.5 }, b: { x: 1, y: 0.5 } });
    scaleArtwork(built, 3);
    expect(built.poses[0]!.positions.a!.x).toBeCloseTo(-1, 4);
    expect(built.poses[0]!.positions.b!.x).toBeCloseTo(2, 4);
  });

  it('ignores a factor that means nothing', () => {
    const built = project({ a: { x: 0.3, y: 0.3 } });
    for (const factor of [1, 0, -2, Number.NaN]) {
      scaleArtwork(built, factor);
      expect(built.poses[0]!.positions.a).toEqual({ x: 0.3, y: 0.3 });
    }
  });
});

describe('through the store', () => {
  function storeWithArtwork() {
    const store = new EditorStore(project({}));
    const a = store.addNodeAt({ x: 0, y: 0.5 });
    const b = store.addNodeAt({ x: 1, y: 0.5 });
    return { store, a, b };
  }

  it('refits on a resize while the option is on', () => {
    const { store, a } = storeWithArtwork();
    const top = store.addNodeAt({ x: 0.5, y: 0 });
    store.updateSettings({ width: 800 });

    expect(store.state.project.settings.width).toBe(800);
    // 1200 -> 800 wide leaves x alone and pulls y in by two thirds, which is
    // exactly what keeps the drawing from being squashed sideways.
    expect(store.positionOf(a)).toEqual({ x: 0, y: 0.5 });
    expect(store.positionOf(top)).toEqual({ x: 0.5, y: 0.1667 });
  });

  it('squashes as before when the option is off', () => {
    const { store } = storeWithArtwork();
    const top = store.addNodeAt({ x: 0.5, y: 0 });
    store.setKeepArtworkProportions(false);
    store.updateSettings({ width: 800 });

    expect(store.state.project.settings.width).toBe(800);
    // Untouched coordinates over a narrower board: the drawing is squashed,
    // which is the raw behaviour this option exists to opt out of.
    expect(store.positionOf(top)).toEqual({ x: 0.5, y: 0 });
  });

  it('undoes a resize and its refit in one step', () => {
    const { store } = storeWithArtwork();
    store.addNodeAt({ x: 0.5, y: 0 });
    const before = structuredClone(store.state.project.poses[0]!.positions);

    store.updateSettings({ width: 800, height: 1200 });
    expect(store.state.project.poses[0]!.positions).not.toEqual(before);

    expect(store.undo()).toBe(true);
    expect(store.state.project.settings).toMatchObject({ width: 1200, height: 800 });
    // The board and the artwork came back together: two entries here would
    // leave the drawing refitted for a board it no longer sits on.
    expect(store.state.project.poses[0]!.positions).toEqual(before);
  });

  it('carries the reference image through the resize with the artwork', () => {
    const { store } = storeWithArtwork();
    store.updateReference({ x: 0, y: 0, scale: 1 });
    store.updateSettings({ width: 800 });

    // Board 1200 -> 800 scales by 2/3 about the centre: a corner at the origin
    // lands a third of the way in, and the image shrinks to match.
    expect(store.state.reference.scale).toBeCloseTo(2 / 3, 4);
    expect(store.state.reference.x).toBeCloseTo(400 - 600 * (2 / 3), 4);
    expect(store.state.project.reference!.scale).toBeCloseTo(2 / 3, 4);
  });

  it('scales the animation as one undo step', () => {
    const { store, a, b } = storeWithArtwork();
    expect(store.scaleArtwork(0.5)).toBe(true);
    expect(store.positionOf(a)).toEqual({ x: 0.25, y: 0.5 });
    expect(store.positionOf(b)).toEqual({ x: 0.75, y: 0.5 });

    expect(store.undo()).toBe(true);
    expect(store.positionOf(a)).toEqual({ x: 0, y: 0.5 });
    expect(store.positionOf(b)).toEqual({ x: 1, y: 0.5 });
  });

  it('refuses a scale that would change nothing', () => {
    const { store } = storeWithArtwork();
    const undoable = store.canUndo;
    expect(store.scaleArtwork(1)).toBe(false);
    expect(store.scaleArtwork(0)).toBe(false);
    expect(store.canUndo).toBe(undoable);
  });
});

describe('the inspector controls', () => {
  function mount() {
    const store = new EditorStore(project({}));
    const a = store.addNodeAt({ x: 0, y: 0.5 });
    // Placing a node selects it; these controls live on the Project panel.
    store.setSelection([], []);
    const inspector = new Inspector(store, {
      onUploadReference: () => {},
      onClearReference: () => {},
      onFitReference: () => {},
      onResetReference: () => {},
    });
    document.body.appendChild(inspector.element);
    return { store, a };
  }

  const scaleInput = () => document.querySelector<HTMLInputElement>('.scale-row .input')!;
  const applyButton = () => document.querySelector<HTMLButtonElement>('.scale-row .btn')!;

  it('offers the proportions toggle, on by default', () => {
    const { store } = mount();
    const toggle = [...document.querySelectorAll<HTMLElement>('.toggle')].find((row) =>
      row.textContent?.includes('Keep artwork proportions'),
    )!;
    const checkbox = toggle.querySelector<HTMLInputElement>('input')!;
    expect(checkbox.checked).toBe(true);

    checkbox.checked = false;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(store.state.keepArtworkProportions).toBe(false);
  });

  it('scales from the percentage box on Apply', () => {
    const { store, a } = mount();
    scaleInput().value = '50';
    applyButton().click();
    expect(store.positionOf(a)).toEqual({ x: 0.25, y: 0.5 });
  });

  it('applies on Enter too, without waiting for the button', () => {
    const { store, a } = mount();
    scaleInput().value = '200';
    scaleInput().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(store.positionOf(a)).toEqual({ x: -0.5, y: 0.5 });
  });

  it('says so rather than acting on a scale that cannot work', () => {
    const { store, a } = mount();
    scaleInput().value = '0';
    applyButton().click();
    expect(store.positionOf(a)).toEqual({ x: 0, y: 0.5 });
    expect(store.state.status?.tone).toBe('error');
  });
});
