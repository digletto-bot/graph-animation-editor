// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Inspector } from '../src/ui/Inspector.ts';
import { EditorStore } from '../src/state/EditorStore.ts';

function mount() {
  const store = new EditorStore();
  const a = store.addNodeAt({ x: 0.2, y: 0.2 });
  const b = store.addNodeAt({ x: 0.6, y: 0.2 });
  const ab = store.addEdgeBetween(a, b)!;
  const inspector = new Inspector(store, {
    onUploadReference: () => {},
    onClearReference: () => {},
    onFitReference: () => {},
    onResetReference: () => {},
  });
  document.body.appendChild(inspector.element);
  return { store, a, b, ab };
}

function sliderFor(label: string): HTMLInputElement {
  const row = [...document.querySelectorAll<HTMLElement>('.field')].find((element) =>
    element.textContent?.includes(label),
  );
  if (!row) throw new Error(`No "${label}" control rendered`);
  return row.querySelector<HTMLInputElement>('input[type="range"]')!;
}

/** One tick of a drag: the browser fires `input`, not `change`. */
function tick(slider: HTMLInputElement, value: number): void {
  slider.value = String(value);
  slider.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/** Handle released: `change` fires once. */
function release(slider: HTMLInputElement): void {
  slider.dispatchEvent(new window.Event('change', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a slider drag is one undo step', () => {
  it('collapses every tick into a single history entry', () => {
    const { store, ab } = mount();
    store.setSelection([], [ab]);
    const slider = sliderFor('Width');

    for (const value of [3, 4, 5, 6, 7]) tick(slider, value);
    release(slider);
    expect(store.edgeById(ab)!.width).toBeCloseTo(7, 4);

    // One undo returns to where the drag began, not to the previous tick.
    expect(store.undo()).toBe(true);
    expect(store.edgeById(ab)!.width).toBeCloseTo(2.4, 4);
    // And the next undo steps past the whole drag to the edge's creation. Only
    // this catches per-tick entries: with them, undo walks back through 6, 5,
    // 4 ... and the first undo alone still looks correct.
    expect(store.undo()).toBe(true);
    expect(store.edgeById(ab)).toBeUndefined();
  });

  it('does the same for a node', () => {
    const { store, a } = mount();
    store.setSelection([a], []);
    const slider = sliderFor('Width');

    for (const value of [3, 5, 8]) tick(slider, value);
    release(slider);

    expect(store.undo()).toBe(true);
    expect(store.nodeById(a)!.width).toBeCloseTo(1.6, 4);
    // The drag left exactly one entry, so the next undo is the edge, not a tick.
    expect(store.undo()).toBe(true);
    expect(store.state.project.edges).toHaveLength(0);
  });

  it('does the same for a bulk edit of several nodes', () => {
    const { store, a, b } = mount();
    store.setSelection([a, b], []);
    const slider = sliderFor('Width');

    for (const value of [4, 6, 9]) tick(slider, value);
    release(slider);
    expect(store.nodeById(a)!.width).toBeCloseTo(9, 4);

    expect(store.undo()).toBe(true);
    expect(store.nodeById(a)!.width).toBeCloseTo(1.6, 4);
    expect(store.nodeById(b)!.width).toBeCloseTo(1.6, 4);
    expect(store.undo()).toBe(true);
    expect(store.state.project.edges).toHaveLength(0);
  });

  it('applies each tick immediately, so the drag stays live', () => {
    const { store, ab } = mount();
    store.setSelection([], [ab]);
    const slider = sliderFor('Width');

    tick(slider, 5);
    // Mid-drag, before any release: the value must already be in the store or
    // the preview could not follow the handle.
    expect(store.edgeById(ab)!.width).toBeCloseTo(5, 4);
  });

  it('closes the gesture on blur, for a keyboard user who never fires change', () => {
    const { store, ab } = mount();
    store.setSelection([], [ab]);
    const slider = sliderFor('Width');

    tick(slider, 5);
    tick(slider, 6);
    slider.dispatchEvent(new window.Event('blur', { bubbles: true }));
    expect(store.hasPendingTransaction).toBe(false);

    expect(store.undo()).toBe(true);
    expect(store.edgeById(ab)!.width).toBeCloseTo(2.4, 4);
    expect(store.undo()).toBe(true);
    expect(store.edgeById(ab)).toBeUndefined();
  });

  it('leaves history alone until the first tick', () => {
    const { store, ab } = mount();
    store.setSelection([], [ab]);
    sliderFor('Width');
    expect(store.hasPendingTransaction).toBe(false);
  });

  it('starts a fresh entry for a second, separate drag', () => {
    const { store, ab } = mount();
    store.setSelection([], [ab]);

    tick(sliderFor('Width'), 5);
    release(sliderFor('Width'));
    tick(sliderFor('Width'), 9);
    release(sliderFor('Width'));

    expect(store.undo()).toBe(true);
    expect(store.edgeById(ab)!.width).toBeCloseTo(5, 4);
    expect(store.undo()).toBe(true);
    expect(store.edgeById(ab)!.width).toBeCloseTo(2.4, 4);
  });
});

/** The panel's own scroller. */
function panelBody(): HTMLElement {
  return document.querySelector<HTMLElement>('.panel-body')!;
}

describe('the panel holds its place while you edit', () => {
  it('keeps the scroll offset when a slider drag settles', () => {
    // The reported bug: releasing the handle rebuilt the panel, which emptied
    // the scroller and parked it back at the top, halfway through an edit.
    const { store, ab } = mount();
    store.setSelection([], [ab]);
    const body = panelBody();
    body.scrollTop = 120;

    const slider = sliderFor('Width');
    tick(slider, 5);
    release(slider);

    expect(body.scrollTop).toBe(120);
  });

  it('keeps the handle itself, so it can still be nudged with the keyboard', () => {
    const { store, ab } = mount();
    store.setSelection([], [ab]);
    const slider = sliderFor('Width');

    tick(slider, 5);
    release(slider);

    // Same element, still in the document: a rebuild would have replaced it and
    // dropped focus with it.
    expect(sliderFor('Width')).toBe(slider);
    expect(slider.isConnected).toBe(true);
  });

  it('keeps the offset through a rebuild driven from outside the panel', () => {
    const { store, a } = mount();
    store.setSelection([a], []);
    const body = panelBody();
    body.scrollTop = 90;

    // An edit from elsewhere does rebuild the panel — but it is still the same
    // node on screen, so the reader stays where they were.
    store.setNodePosition(a, { x: 0.7, y: 0.7 });
    expect(body.scrollTop).toBe(90);
  });

  it('starts at the top when a different panel takes over', () => {
    const { store, a } = mount();
    store.setSelection([a], []);
    const body = panelBody();
    body.scrollTop = 90;

    store.setSelection([], []);
    expect(body.scrollTop).toBe(0);
  });
});
