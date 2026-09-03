import { h } from '../utils/dom.ts';

const SHORTCUTS: Array<[string, string]> = [
  ['V', 'Select tool'],
  ['N', 'Add node'],
  ['E', 'Add edge'],
  ['L', 'Lasso select'],
  ['H', 'Pan view'],
  ['O', 'Occluder tool'],
  ['Q', 'Cycle selection: nodes and edges / nodes / edges'],
  ['Space + drag', 'Temporary pan from any tool'],
  ['Middle-drag', 'Pan view'],
  ['Wheel', 'Zoom around the pointer'],
  ['Shift + click', 'Add or remove from selection'],
  ['Alt + click', 'Place a node ignoring snapping'],
  ['Shift + scale', 'Uniform scale in the transform box'],
  ['Delete / Backspace', 'Delete selection'],
  ['Enter', 'Close the occluder polygon being drawn'],
  ['Escape', 'Cancel operation or clear selection'],
  ['Ctrl/Cmd + Z', 'Undo'],
  ['Ctrl/Cmd + Shift + Z', 'Redo'],
  ['Ctrl/Cmd + Y', 'Redo'],
  ['0', 'Fit project in view'],
  ['P', 'Toggle Edit and Preview'],
  ['?', 'Open this list'],
];

export class ShortcutsDialog {
  element: HTMLDialogElement;

  constructor() {
    const rows = SHORTCUTS.map(([keys, description]) =>
      h('div', { class: 'shortcut-row' }, [
        h('kbd', { class: 'kbd', text: keys }),
        h('span', { text: description }),
      ]),
    );

    this.element = h('dialog', { class: 'dialog' }, [
      h('div', { class: 'dialog-head' }, [
        h('h2', { class: 'panel-title', text: 'Keyboard shortcuts' }),
        h('button', {
          class: 'btn',
          type: 'button',
          text: 'Close',
          on: { click: () => this.close() },
        }),
      ]),
      h('div', { class: 'shortcut-grid' }, rows),
    ]) as HTMLDialogElement;

    this.element.addEventListener('click', (event) => {
      if (event.target === this.element) this.close();
    });
  }

  open(): void {
    if (!this.element.open) this.element.showModal();
  }

  close(): void {
    if (this.element.open) this.element.close();
  }

  toggle(): void {
    if (this.element.open) this.close();
    else this.open();
  }
}
