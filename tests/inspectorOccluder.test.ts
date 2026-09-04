// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Inspector } from '../src/ui/Inspector.ts';
import { layeredStore } from './support/layeredProject.ts';

/**
 * The occluder panel outranks every other view in the Inspector, so if nothing
 * clears it — or the panel simply fails to repaint when something does — it is
 * a dead end with no way back to the project view. Store-level tests cannot see
 * that second failure mode, which is why these drive the real panel.
 *
 * Inspector pulls in no Konva, so it mounts in bare jsdom without a canvas.
 */
function mount() {
  const store = layeredStore();
  const a = store.addNodeAt({ x: 0.2, y: 0.2 });
  const b = store.addNodeAt({ x: 0.8, y: 0.2 });
  const c = store.addNodeAt({ x: 0.5, y: 0.8 });
  const occluderId = store.addOccluder([a, b, c])!;
  const inspector = new Inspector(store, {
    onUploadReference: () => {},
    onClearReference: () => {},
    onFitReference: () => {},
    onResetReference: () => {},
  });
  document.body.appendChild(inspector.element);
  return { store, inspector, a, b, c, occluderId };
}

function title(inspector: Inspector): string {
  return inspector.element.querySelector('.panel-title')!.textContent ?? '';
}

describe('the occluder panel is not a dead end', () => {
  it('shows the occluder once one is selected', () => {
    const { inspector } = mount();
    expect(title(inspector)).toBe('Occluder');
  });

  it('returns to the project view on the Escape path', () => {
    const { store, inspector } = mount();
    store.clearSelection();
    expect(title(inspector)).toBe('Project');
  });

  it('switches to the node view when a node is picked', () => {
    const { store, inspector, a } = mount();
    store.setSelection([a], []);
    expect(title(inspector)).toBe('Node');
  });

  it('switches to the multi view when a marquee catches several', () => {
    const { store, inspector, a, b } = mount();
    store.setSelection([a, b], []);
    expect(title(inspector)).toBe('Multiple selection');
  });

  it('comes back when the occluder is selected again', () => {
    const { store, inspector, occluderId } = mount();
    store.clearSelection();
    store.selectOccluder(occluderId);
    expect(title(inspector)).toBe('Occluder');
  });
});
