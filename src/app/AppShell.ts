import type { EditorStore } from '../state/EditorStore.ts';
import { h, button } from '../utils/dom.ts';

export interface ShellCallbacks {
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onSave: () => void;
  onLoad: () => void;
  onReset: () => void;
  onShortcuts: () => void;
}

/**
 * Static chrome: top bar, the two stage hosts, and the slots the panels mount
 * into. Everything here reads from the store; nothing here owns state.
 */
export class AppShell {
  private store: EditorStore;
  element: HTMLElement;

  railSlot: HTMLElement;
  inspectorSlot: HTMLElement;
  timelineSlot: HTMLElement;
  konvaHost: HTMLDivElement;
  previewHost: HTMLDivElement;
  previewCanvas: HTMLCanvasElement;
  previewControlsSlot: HTMLElement;

  private editButton: HTMLButtonElement;
  private previewButton: HTMLButtonElement;
  private undoButton: HTMLButtonElement;
  private redoButton: HTMLButtonElement;
  private statusElement: HTMLElement;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(store: EditorStore, callbacks: ShellCallbacks) {
    this.store = store;

    this.editButton = h('button', {
      class: 'mode-btn',
      type: 'button',
      text: 'Edit',
      on: { click: () => this.store.setMode('edit') },
    });
    this.previewButton = h('button', {
      class: 'mode-btn',
      type: 'button',
      text: 'Preview',
      on: { click: () => this.store.setMode('preview') },
    });

    this.undoButton = button('Undo', callbacks.onUndo, { title: 'Ctrl/Cmd + Z' });
    this.redoButton = button('Redo', callbacks.onRedo, { title: 'Ctrl/Cmd + Shift + Z' });

    const importInput = h('input', {
      type: 'file',
      class: 'visually-hidden',
      attrs: { accept: 'application/json,.json' },
    });
    importInput.addEventListener('change', () => {
      const file = importInput.files?.[0];
      if (file) callbacks.onImport(file);
      importInput.value = '';
    });

    this.statusElement = h('span', { class: 'status', text: 'Ready' });

    const topbar = h('header', { class: 'topbar' }, [
      h('div', { class: 'brand' }, [
        h('span', { class: 'brand-mark' }),
        h('span', { class: 'brand-name', text: 'Line Bird' }),
        h('span', { class: 'brand-sub', text: 'graph animation editor' }),
      ]),
      h('div', { class: 'mode-switch' }, [this.editButton, this.previewButton]),
      h('div', { class: 'topbar-actions' }, [
        this.undoButton,
        this.redoButton,
        h('span', { class: 'topbar-divider' }),
        button('Save to browser', callbacks.onSave),
        button('Load from browser', callbacks.onLoad),
        h('span', { class: 'topbar-divider' }),
        button('Export JSON', callbacks.onExport, { class: 'btn btn-accent' }),
        button('Import JSON', () => importInput.click()),
        button('Reset', callbacks.onReset, { class: 'btn btn-danger' }),
        h('span', { class: 'topbar-divider' }),
        button('?', callbacks.onShortcuts, { title: 'Keyboard shortcuts' }),
        importInput,
      ]),
      this.statusElement,
    ]);

    this.konvaHost = h('div', { class: 'stage-host' });
    this.previewCanvas = h('canvas', { class: 'preview-canvas' });
    this.previewControlsSlot = h('div', { class: 'preview-controls' });
    this.previewHost = h('div', { class: 'preview-host' }, [
      this.previewCanvas,
      this.previewControlsSlot,
    ]);

    this.railSlot = h('div', { class: 'rail-slot' });
    this.inspectorSlot = h('div', { class: 'inspector-slot' });
    this.timelineSlot = h('div', { class: 'timeline-slot' });

    this.element = h('div', { class: 'app' }, [
      topbar,
      h('main', { class: 'workspace' }, [
        this.railSlot,
        h('div', { class: 'stage-area' }, [this.konvaHost, this.previewHost]),
        this.inspectorSlot,
      ]),
      this.timelineSlot,
    ]);

    store.subscribe((changes) => {
      if (changes.has('mode') || changes.has('history') || changes.has('project')) this.render();
      if (changes.has('status')) this.renderStatus();
    });
    this.render();
  }

  private render(): void {
    const mode = this.store.state.mode;
    this.editButton.classList.toggle('is-active', mode === 'edit');
    this.previewButton.classList.toggle('is-active', mode === 'preview');
    this.element.dataset.mode = mode;
    this.undoButton.disabled = !this.store.canUndo;
    this.redoButton.disabled = !this.store.canRedo;
  }

  private renderStatus(): void {
    const status = this.store.state.status;
    const state = this.store.state;
    if (status) {
      this.statusElement.textContent = status.message;
      this.statusElement.dataset.tone = status.tone;
      if (this.statusTimer) clearTimeout(this.statusTimer);
      this.statusTimer = setTimeout(() => {
        this.store.state.status = null;
        this.renderStatus();
      }, 4000);
      return;
    }
    this.statusElement.dataset.tone = 'idle';
    if (state.dirty) {
      this.statusElement.textContent = 'Unsaved changes';
    } else if (state.lastSavedAt) {
      const time = new Date(state.lastSavedAt);
      this.statusElement.textContent = `Saved ${time.getHours().toString().padStart(2, '0')}:${time
        .getMinutes()
        .toString()
        .padStart(2, '0')}`;
    } else {
      this.statusElement.textContent = 'Ready';
    }
  }
}
