// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { PartsPanel } from '../src/ui/PartsPanel.ts';
import { BODY_PART_ID, FAR_WING_PART_ID, NEAR_WING_PART_ID } from '../src/runtime/parts.ts';
import { layeredStore } from './support/layeredProject.ts';

/**
 * Drives the real panel through real pointer gestures in jsdom.
 *
 * These exist because of a bug that no store-level test could have caught: the
 * row activates on pointerdown and re-renders the list, which replaced the
 * button under the cursor before pointerup, so its click never fired.
 * PartsPanel pulls in no Konva, so it mounts here without a canvas backend.
 */

function mount() {
  const store = layeredStore();
  const panel = new PartsPanel(store);
  document.body.appendChild(panel.element);
  return { store, panel };
}

/** Row order is front-to-back: near wing, body, far wing. */
function rowFor(panel: PartsPanel, partId: string): HTMLElement {
  const order = [NEAR_WING_PART_ID, BODY_PART_ID, FAR_WING_PART_ID];
  const rows = panel.element.querySelectorAll('.part-row');
  return rows[order.indexOf(partId)] as HTMLElement;
}

function toggleIn(row: HTMLElement, label: string): HTMLButtonElement {
  const buttons = [...row.querySelectorAll('.part-toggle')] as HTMLButtonElement[];
  const match = buttons.find((button) => button.textContent === label);
  if (!match) throw new Error(`No "${label}" toggle in this row`);
  return match;
}

/** A full press: pointerdown then click, the way a browser delivers it. */
function press(element: HTMLElement): void {
  element.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('parts panel toggles', () => {
  it('applies a toggle pressed on a row that is not active', () => {
    const { store, panel } = mount();
    // The body is active by default, so the far wing row is the risky one.
    expect(store.state.activePartId).toBe(BODY_PART_ID);

    press(toggleIn(rowFor(panel, FAR_WING_PART_ID), 'H'));

    expect(store.partStateOf(FAR_WING_PART_ID).visible).toBe(false);
    // And pressing a control does not steal the active part from the body.
    expect(store.state.activePartId).toBe(BODY_PART_ID);
  });

  it('repaints the button immediately, without waiting for another click', () => {
    const { store, panel } = mount();
    const before = toggleIn(rowFor(panel, BODY_PART_ID), 'H');
    expect(before.classList.contains('is-on')).toBe(false);

    press(before);

    // Re-read from the DOM: the panel rebuilds its rows on change.
    const after = toggleIn(rowFor(panel, BODY_PART_ID), 'H');
    expect(after.classList.contains('is-on')).toBe(true);
    expect(store.partStateOf(BODY_PART_ID).visible).toBe(false);
  });

  it('toggles back off on a second press', () => {
    const { store, panel } = mount();
    press(toggleIn(rowFor(panel, BODY_PART_ID), 'L'));
    expect(store.partStateOf(BODY_PART_ID).locked).toBe(true);

    press(toggleIn(rowFor(panel, BODY_PART_ID), 'L'));
    expect(store.partStateOf(BODY_PART_ID).locked).toBe(false);
    expect(toggleIn(rowFor(panel, BODY_PART_ID), 'L').classList.contains('is-on')).toBe(false);
  });

  it('keeps the five controls independent of each other', () => {
    const { store, panel } = mount();
    const row = () => rowFor(panel, FAR_WING_PART_ID);

    press(toggleIn(row(), 'L'));
    press(toggleIn(row(), 'X'));

    const display = store.state.partDisplay[FAR_WING_PART_ID]!;
    expect(display).toMatchObject({ locked: true, xray: true, hidden: false, solo: false });
    // Runtime render is a separate, project-level flag and stays untouched.
    expect(store.partById(FAR_WING_PART_ID)!.renderEnabled).toBe(true);

    expect(toggleIn(row(), 'L').classList.contains('is-on')).toBe(true);
    expect(toggleIn(row(), 'X').classList.contains('is-on')).toBe(true);
    expect(toggleIn(row(), 'H').classList.contains('is-on')).toBe(false);
    expect(toggleIn(row(), 'S').classList.contains('is-on')).toBe(false);
  });

  it('drives solo across rows and offers a clear-solo escape', () => {
    const { store, panel } = mount();
    press(toggleIn(rowFor(panel, BODY_PART_ID), 'S'));
    press(toggleIn(rowFor(panel, NEAR_WING_PART_ID), 'S'));

    expect(store.partStateOf(BODY_PART_ID).visible).toBe(true);
    expect(store.partStateOf(NEAR_WING_PART_ID).visible).toBe(true);
    expect(store.partStateOf(FAR_WING_PART_ID).visible).toBe(false);

    const clear = [...panel.element.querySelectorAll('button')].find(
      (button) => button.textContent === 'Clear solo',
    );
    expect(clear).toBeDefined();
    press(clear!);
    expect(store.partStateOf(FAR_WING_PART_ID).visible).toBe(true);
  });

  it('toggles runtime render from the R control', () => {
    const { store, panel } = mount();
    press(toggleIn(rowFor(panel, FAR_WING_PART_ID), 'R'));
    expect(store.partById(FAR_WING_PART_ID)!.renderEnabled).toBe(false);
    expect(toggleIn(rowFor(panel, FAR_WING_PART_ID), 'R').classList.contains('is-on')).toBe(false);
    // This one is project data, so it is undoable.
    expect(store.undo()).toBe(true);
    expect(store.partById(FAR_WING_PART_ID)!.renderEnabled).toBe(true);
  });

  it('reorders from a row that is not active', () => {
    const { store, panel } = mount();
    const before = store.partsInOrder.map((part) => part.id);
    const downButton = [...rowFor(panel, NEAR_WING_PART_ID).querySelectorAll('.part-move')].find(
      (button) => button.textContent === '↓',
    ) as HTMLButtonElement;

    press(downButton);

    expect(store.partsInOrder.map((part) => part.id)).not.toEqual(before);
    expect(store.partsInOrder.map((part) => part.id)).toEqual([
      FAR_WING_PART_ID,
      NEAR_WING_PART_ID,
      BODY_PART_ID,
    ]);
  });

  it('still activates a part when the row itself is pressed', () => {
    const { store, panel } = mount();
    rowFor(panel, FAR_WING_PART_ID).dispatchEvent(
      new window.PointerEvent('pointerdown', { bubbles: true }),
    );
    expect(store.state.activePartId).toBe(FAR_WING_PART_ID);
    expect(rowFor(panel, FAR_WING_PART_ID).classList.contains('is-active')).toBe(true);
  });
});
