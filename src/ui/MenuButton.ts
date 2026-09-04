import { h } from '../utils/dom.ts';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Right-aligned note: a keyboard shortcut, or what the item costs you. */
  hint?: string;
  title?: string;
  tone?: 'accent' | 'danger';
}

export interface MenuGroup {
  /** Heading above the group. The first group usually needs none. */
  label?: string;
  items: MenuItem[];
}

/**
 * A button that drops a menu panel under itself.
 *
 * The top bar only has room for the controls used every minute — modes, undo,
 * redo — so everything occasional (files, browser storage, help) lives in here
 * instead. Built on plain buttons rather than a native <select> or <dialog> so
 * it can carry groups, hints and tones, and be styled like the rest of the app.
 */
export class MenuButton {
  element: HTMLElement;
  private button: HTMLButtonElement;
  private popup: HTMLElement;
  private items: HTMLButtonElement[] = [];
  /** Bound once so the same reference can be removed again. */
  private onDocumentPointerDown = (event: PointerEvent) => {
    if (!this.element.contains(event.target as Node)) this.close();
  };

  constructor(label: string, groups: MenuGroup[], options: { title?: string } = {}) {
    this.button = h('button', {
      class: 'btn menu-button',
      type: 'button',
      title: options.title ?? '',
      attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      on: { click: () => this.toggle() },
    }, [h('span', { text: label }), h('span', { class: 'menu-caret', text: '▾' })]);

    this.popup = h('div', {
      class: 'menu-popup',
      attrs: { role: 'menu', 'aria-label': label },
    });
    this.popup.hidden = true;

    for (const group of groups) {
      const rows: HTMLElement[] = [];
      if (group.label) rows.push(h('div', { class: 'menu-group-label', text: group.label }));
      for (const item of group.items) rows.push(this.renderItem(item));
      this.popup.appendChild(h('div', { class: 'menu-group' }, rows));
    }

    this.element = h('div', { class: 'menu' }, [this.button, this.popup]);
    this.element.addEventListener('keydown', (event) => this.handleKey(event));
  }

  private renderItem(item: MenuItem): HTMLButtonElement {
    const classes = ['menu-item'];
    if (item.tone) classes.push(`is-${item.tone}`);
    const button = h('button', {
      class: classes.join(' '),
      type: 'button',
      title: item.title ?? '',
      attrs: { role: 'menuitem' },
      on: {
        click: () => {
          // Closing first keeps the panel from hanging over a confirm dialog,
          // and leaves the app in a settled state before the action runs.
          this.close();
          item.onSelect();
        },
      },
    }, [
      h('span', { text: item.label }),
      item.hint ? h('span', { class: 'menu-item-hint', text: item.hint }) : null,
    ]);
    this.items.push(button);
    return button;
  }

  get isOpen(): boolean {
    return !this.popup.hidden;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpen) return;
    this.popup.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.button.classList.add('is-active');
    document.addEventListener('pointerdown', this.onDocumentPointerDown);
  }

  close(): void {
    if (!this.isOpen) return;
    this.popup.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.button.classList.remove('is-active');
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);
  }

  /**
   * Escape closes, and the arrow keys walk the items. The keydown is swallowed
   * either way: the editor listens on the window for single-key shortcuts, and
   * an open menu must not also be placing nodes.
   */
  private handleKey(event: KeyboardEvent): void {
    if (!this.isOpen) return;
    const key = event.key;

    if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      this.button.focus();
      return;
    }
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;

    event.preventDefault();
    event.stopPropagation();
    const current = this.items.indexOf(document.activeElement as HTMLButtonElement);
    const last = this.items.length - 1;
    let next = 0;
    if (key === 'End') next = last;
    else if (key === 'ArrowDown') next = current >= last ? 0 : current + 1;
    else if (key === 'ArrowUp') next = current <= 0 ? last : current - 1;
    this.items[next]?.focus();
  }
}
