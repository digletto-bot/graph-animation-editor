// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorStore } from '../src/state/EditorStore.ts';
import { AppShell } from '../src/app/AppShell.ts';
import { MenuButton } from '../src/ui/MenuButton.ts';

beforeEach(() => {
  document.body.innerHTML = '';
});

/** The shell with every callback spied on, mounted in the document. */
function shell(store = new EditorStore()) {
  const calls = {
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onExport: vi.fn(),
    onImport: vi.fn(),
    onSave: vi.fn(),
    onLoad: vi.fn(),
    onNewProject: vi.fn(),
    onShortcuts: vi.fn(),
  };
  const element = new AppShell(store, calls).element;
  document.body.appendChild(element);
  return { element, calls };
}

const items = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('.menu-item')];

function itemNamed(root: HTMLElement, label: string): HTMLButtonElement {
  const found = items(root).find((item) => item.textContent?.startsWith(label));
  expect(found, `no menu item labelled ${label}`).toBeDefined();
  return found!;
}

function openMenu(root: HTMLElement): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>('.menu-button')!;
  button.click();
  return button;
}

describe('what stays in the top bar', () => {
  it('keeps the mode switch and undo/redo out of the menu', () => {
    const { element } = shell();
    const bar = element.querySelector<HTMLElement>('.topbar')!;
    const barButtons = [...bar.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => !button.closest('.menu-popup'),
    );
    expect(barButtons.map((button) => button.textContent)).toEqual([
      'Edit',
      'Preview',
      'Undo',
      'Redo',
      'Menu▾',
    ]);
  });

  it('drives undo and redo straight from the bar', () => {
    // Undo is disabled with an untouched project, so give it something to undo.
    const store = new EditorStore();
    store.addNodeAt({ x: 0.5, y: 0.5 });
    const { element, calls } = shell(store);
    const bar = element.querySelector<HTMLElement>('.topbar')!;
    [...bar.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Undo')!
      .click();
    expect(calls.onUndo).toHaveBeenCalledTimes(1);
  });
});

describe('the top bar menu', () => {
  it('starts closed and opens on the button', () => {
    const { element } = shell();
    const popup = element.querySelector<HTMLElement>('.menu-popup')!;
    expect(popup.hidden).toBe(true);

    const button = openMenu(element);
    expect(popup.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('groups the actions it took over from the bar', () => {
    const { element } = shell();
    openMenu(element);
    expect(items(element).map((item) => item.firstChild?.textContent)).toEqual([
      'Export JSON',
      'Import JSON…',
      'New project',
      'Save to browser',
      'Load from browser',
      'Keyboard shortcuts',
    ]);
    expect(
      [...element.querySelectorAll('.menu-group-label')].map((label) => label.textContent),
    ).toEqual(['Project', 'This browser', 'Help']);
  });

  it('runs the action and closes, so nothing hangs over a confirm dialog', () => {
    const { element, calls } = shell();
    openMenu(element);
    itemNamed(element, 'New project').click();

    expect(calls.onNewProject).toHaveBeenCalledTimes(1);
    expect(element.querySelector<HTMLElement>('.menu-popup')!.hidden).toBe(true);
  });

  it('reaches every callback the bar used to hold', () => {
    const { element, calls } = shell();
    for (const [label, spy] of [
      ['Export JSON', calls.onExport],
      ['Save to browser', calls.onSave],
      ['Load from browser', calls.onLoad],
      ['Keyboard shortcuts', calls.onShortcuts],
    ] as const) {
      openMenu(element);
      itemNamed(element, label).click();
      expect(spy, label).toHaveBeenCalledTimes(1);
    }
  });

  it('opens the file picker for an import', () => {
    const { element } = shell();
    const input = element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    openMenu(element);
    itemNamed(element, 'Import JSON').click();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('closes on a pointer press outside itself, and stays open inside', () => {
    const { element } = shell();
    const popup = element.querySelector<HTMLElement>('.menu-popup')!;

    openMenu(element);
    popup.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
    expect(popup.hidden).toBe(false);

    document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
    expect(popup.hidden).toBe(true);
  });

  it('closes on Escape and hands focus back to the button', () => {
    const { element } = shell();
    const button = openMenu(element);
    const popup = element.querySelector<HTMLElement>('.menu-popup')!;

    popup.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popup.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it('swallows its keys, so the editor does not act on them too', () => {
    // Single keys place nodes and switch tools on the window. An open menu must
    // absorb the ones it uses rather than letting them through.
    const { element } = shell();
    openMenu(element);
    const seen: string[] = [];
    window.addEventListener('keydown', (event) => seen.push(event.key));

    const popup = element.querySelector<HTMLElement>('.menu-popup')!;
    popup.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    popup.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(seen).toEqual([]);
  });

  it('walks the items with the arrow keys, wrapping at both ends', () => {
    const menu = new MenuButton('Menu', [
      {
        items: [
          { label: 'One', onSelect: () => {} },
          { label: 'Two', onSelect: () => {} },
        ],
      },
      { label: 'More', items: [{ label: 'Three', onSelect: () => {} }] },
    ]);
    document.body.appendChild(menu.element);
    menu.open();
    const rows = items(menu.element);

    const press = (key: string) =>
      menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));

    press('ArrowDown');
    expect(document.activeElement).toBe(rows[0]);
    press('ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
    press('ArrowUp');
    expect(document.activeElement).toBe(rows[0]);
    // Wrapping in both directions, across the group divider.
    press('ArrowUp');
    expect(document.activeElement).toBe(rows[2]);
    press('ArrowDown');
    expect(document.activeElement).toBe(rows[0]);
    press('End');
    expect(document.activeElement).toBe(rows[2]);
    press('Home');
    expect(document.activeElement).toBe(rows[0]);
  });

  it('ignores keys and outside presses once it is closed', () => {
    const { element } = shell();
    const popup = element.querySelector<HTMLElement>('.menu-popup')!;
    const seen: string[] = [];
    window.addEventListener('keydown', (event) => seen.push(event.key));

    popup.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(seen).toEqual(['Escape']);
    expect(popup.hidden).toBe(true);
  });
});
