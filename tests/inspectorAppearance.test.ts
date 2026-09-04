// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Inspector } from '../src/ui/Inspector.ts';
import { EditorStore } from '../src/state/EditorStore.ts';
import { NEAR_WING_PART_ID } from '../src/model/parts.ts';

function mount() {
  const store = new EditorStore();
  const a = store.addNodeAt({ x: 0.2, y: 0.2 });
  const b = store.addNodeAt({ x: 0.5, y: 0.2 });
  const c = store.addNodeAt({ x: 0.8, y: 0.2 });
  const ab = store.addEdgeBetween(a, b)!;
  const bc = store.addEdgeBetween(b, c)!;
  const inspector = new Inspector(store, {
    onUploadReference: () => {},
    onClearReference: () => {},
    onFitReference: () => {},
    onResetReference: () => {},
  });
  document.body.appendChild(inspector.element);
  return { store, inspector, a, b, c, ab, bc };
}

function section(title: string): HTMLElement | null {
  const headings = [...document.querySelectorAll<HTMLElement>('.section-title')];
  const match = headings.find(
    (element) => element.querySelector('.section-title-text')?.textContent === title,
  );
  return match ? (match.parentElement as HTMLElement) : null;
}

/** Drag the slider labelled `label` inside a section to `value`. */
function drag(sectionTitle: string, label: string, value: number): void {
  const host = section(sectionTitle);
  if (!host) throw new Error(`No "${sectionTitle}" section rendered`);
  const row = [...host.querySelectorAll<HTMLElement>('.field')].find(
    (element) => element.textContent?.includes(label),
  );
  if (!row) throw new Error(`No "${label}" control in "${sectionTitle}"`);
  const input = row.querySelector<HTMLInputElement>('input[type="range"]')!;
  input.value = String(value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a single selected edge', () => {
  it('already exposes width, brightness and seed', () => {
    const { store, ab } = mount();
    store.setSelection([], [ab]);
    const appearance = section('Appearance');
    expect(appearance).not.toBeNull();
    expect(appearance!.textContent).toContain('Width');
    expect(appearance!.textContent).toContain('Brightness');
    expect(appearance!.textContent).toContain('Noise seed');
  });

  it('writes a dragged width straight to the edge', () => {
    const { store, ab } = mount();
    store.setSelection([], [ab]);
    drag('Appearance', 'Width', 6.5);
    expect(store.edgeById(ab)!.width).toBeCloseTo(6.5, 4);
  });
});

describe('several selected edges', () => {
  it('offers width and brightness for the whole selection', () => {
    const { store, ab, bc } = mount();
    store.setSelection([], [ab, bc]);
    const appearance = section('Edge appearance');
    expect(appearance).not.toBeNull();
    expect(appearance!.textContent).toContain('Applies to all 2 selected edges');
  });

  it('applies a width change to every one of them', () => {
    const { store, ab, bc } = mount();
    store.setSelection([], [ab, bc]);
    drag('Edge appearance', 'Width', 7);
    expect(store.edgeById(ab)!.width).toBeCloseTo(7, 4);
    expect(store.edgeById(bc)!.width).toBeCloseTo(7, 4);
  });

  it('applies a brightness change to every one of them', () => {
    const { store, ab, bc } = mount();
    store.setSelection([], [ab, bc]);
    drag('Edge appearance', 'Brightness', 1.5);
    expect(store.edgeById(ab)!.brightness).toBeCloseTo(1.5, 4);
    expect(store.edgeById(bc)!.brightness).toBeCloseTo(1.5, 4);
  });

  it('says so, and starts from the mean, when the edges disagree', () => {
    const { store, ab, bc } = mount();
    store.updateEdge(ab, { width: 2 });
    store.updateEdge(bc, { width: 4 });
    store.setSelection([], [ab, bc]);

    const appearance = section('Edge appearance')!;
    expect(appearance.textContent).toContain('differ');
    const width = [...appearance.querySelectorAll<HTMLInputElement>('input[type="range"]')][0]!;
    expect(Number(width.value)).toBeCloseTo(3, 4);
  });

  it('shows the shared value when they agree', () => {
    const { store, ab, bc } = mount();
    store.updateEdge(ab, { width: 5 });
    store.updateEdge(bc, { width: 5 });
    store.setSelection([], [ab, bc]);

    const appearance = section('Edge appearance')!;
    expect(appearance.textContent).not.toContain('differ');
    const width = [...appearance.querySelectorAll<HTMLInputElement>('input[type="range"]')][0]!;
    expect(Number(width.value)).toBeCloseTo(5, 4);
  });

  it('appears alongside nodes in a mixed selection', () => {
    const { store, a, ab } = mount();
    store.setSelection([a], [ab]);
    expect(section('Edge appearance')).not.toBeNull();
  });

  it('is absent when only nodes are selected', () => {
    const { store, a, b } = mount();
    store.setSelection([a, b], []);
    expect(section('Edge appearance')).toBeNull();
  });
});

describe('bulk edge edits in the store', () => {
  it('are a single undoable step', () => {
    const { store, ab, bc } = mount();
    store.updateEdges([ab, bc], { width: 9 });
    expect(store.undo()).toBe(true);
    expect(store.edgeById(ab)!.width).not.toBeCloseTo(9, 4);
    expect(store.edgeById(bc)!.width).not.toBeCloseTo(9, 4);
  });

  it('skip edges on a locked part rather than editing them', () => {
    const { store, ab, bc } = mount();
    store.setEdgePart(bc, NEAR_WING_PART_ID);
    store.updatePartDisplay(NEAR_WING_PART_ID, { locked: true });
    store.updateEdges([ab, bc], { width: 8 });
    expect(store.edgeById(ab)!.width).toBeCloseTo(8, 4);
    expect(store.edgeById(bc)!.width).not.toBeCloseTo(8, 4);
  });

  it('do nothing at all when no edge is editable', () => {
    const { store } = mount();
    const undoableBefore = store.canUndo;
    store.updateEdges([], { width: 8 });
    expect(store.canUndo).toBe(undoableBefore);
  });
});

describe('node appearance controls', () => {
  it('appear for a single selected node', () => {
    const { store, a } = mount();
    store.setSelection([a], []);
    const appearance = section('Appearance');
    expect(appearance).not.toBeNull();
    expect(appearance!.textContent).toContain('Width');
    expect(appearance!.textContent).toContain('Brightness');
  });

  it('write a dragged width straight to the node', () => {
    const { store, a } = mount();
    store.setSelection([a], []);
    drag('Appearance', 'Width', 5.5);
    expect(store.nodeById(a)!.width).toBeCloseTo(5.5, 4);
  });

  it('write a dragged brightness straight to the node', () => {
    const { store, a } = mount();
    store.setSelection([a], []);
    drag('Appearance', 'Brightness', 0.4);
    expect(store.nodeById(a)!.brightness).toBeCloseTo(0.4, 4);
  });

  it('apply to every node of a multi-selection', () => {
    const { store, a, b } = mount();
    store.setSelection([a, b], []);
    drag('Node appearance', 'Width', 7);
    expect(store.nodeById(a)!.width).toBeCloseTo(7, 4);
    expect(store.nodeById(b)!.width).toBeCloseTo(7, 4);
  });

  it('start from the mean and say so when the nodes disagree', () => {
    const { store, a, b } = mount();
    store.updateNode(a, { width: 2 });
    store.updateNode(b, { width: 6 });
    store.setSelection([a, b], []);

    const appearance = section('Node appearance')!;
    expect(appearance.textContent).toContain('differ');
    const width = [...appearance.querySelectorAll<HTMLInputElement>('input[type="range"]')][0]!;
    expect(Number(width.value)).toBeCloseTo(4, 4);
  });

  it('sit alongside the edge controls in a mixed selection', () => {
    const { store, a, ab } = mount();
    store.setSelection([a], [ab]);
    expect(section('Node appearance')).not.toBeNull();
    expect(section('Edge appearance')).not.toBeNull();
  });

  it('are absent when only edges are selected', () => {
    const { store, ab, bc } = mount();
    store.setSelection([], [ab, bc]);
    expect(section('Node appearance')).toBeNull();
  });
});
