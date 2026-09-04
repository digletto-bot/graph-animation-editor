import type { EditorStore } from '../state/EditorStore.ts';
import { h, button } from '../utils/dom.ts';
import { MenuButton } from '../ui/MenuButton.ts';

export interface ShellCallbacks {
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onSave: () => void;
  onLoad: () => void;
  onNewProject: () => void;
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
  private nameInput: HTMLInputElement;
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

    // The document name, edited in place. It titles the project and names the
    // exported files, so it belongs in the chrome rather than behind a panel.
    this.nameInput = h('input', {
      class: 'project-name',
      type: 'text',
      title: 'Project name — used for exported filenames',
      attrs: { 'aria-label': 'Project name' },
      placeholder: 'Untitled',
      value: store.state.project.name,
    });
    this.nameInput.addEventListener('change', () => {
      this.store.setProjectName(this.nameInput.value);
      // A blank or duplicate entry is normalised by the store, so read back.
      this.nameInput.value = this.store.state.project.name;
    });

    this.statusElement = h('span', { class: 'status', text: 'Ready' });

    // Everything that is not a per-minute control lives behind one menu, so the
    // bar itself stays down to modes, undo/redo and the document's name.
    const menu = new MenuButton(
      'Menu',
      [
        {
          label: 'Project',
          items: [
            {
              label: 'Export JSON',
              tone: 'accent',
              onSelect: callbacks.onExport,
              title: 'Save the project to a file',
            },
            {
              label: 'Import JSON…',
              onSelect: () => importInput.click(),
              title: 'Replace the project with one from a file',
            },
            {
              label: 'New project',
              tone: 'danger',
              onSelect: callbacks.onNewProject,
              title: 'Discard this project and start an empty one',
            },
          ],
        },
        {
          label: 'This browser',
          items: [
            { label: 'Save to browser', onSelect: callbacks.onSave },
            { label: 'Load from browser', onSelect: callbacks.onLoad },
          ],
        },
        {
          label: 'Help',
          items: [{ label: 'Keyboard shortcuts', hint: '?', onSelect: callbacks.onShortcuts }],
        },
      ],
      { title: 'Files, browser storage and help' },
    );

    // Three zones: identity on the left, the mode switch centred on the bar
    // itself (not on whatever is left over), actions on the right.
    const topbar = h('header', { class: 'topbar' }, [
      h('div', { class: 'topbar-left' }, [
        h('div', { class: 'brand' }, [
          h('span', { class: 'brand-mark' }),
          h('span', { class: 'brand-name', text: 'Line Bird' }),
          h('span', { class: 'brand-sub', text: 'graph animation editor' }),
        ]),
        this.nameInput,
        this.statusElement,
      ]),
      h('div', { class: 'mode-switch' }, [this.editButton, this.previewButton]),
      h('div', { class: 'topbar-actions' }, [
        this.undoButton,
        this.redoButton,
        h('span', { class: 'topbar-divider' }),
        menu.element,
        importInput,
      ]),
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
    // Never fight the user for the caret while they are typing in it.
    const name = this.store.state.project.name;
    if (document.activeElement !== this.nameInput && this.nameInput.value !== name) {
      this.nameInput.value = name;
    }
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
