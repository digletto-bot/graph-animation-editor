import type { SelectionMode, ToolId } from '../model/types.ts';
import type { EditorStore } from '../state/EditorStore.ts';
import { h } from '../utils/dom.ts';

interface ToolDefinition {
  id: ToolId;
  glyph: string;
  label: string;
  shortcut: string;
}

const TOOLS: ToolDefinition[] = [
  { id: 'select', glyph: '⌖', label: 'Select and move', shortcut: 'V' },
  { id: 'node', glyph: '＋', label: 'Add node', shortcut: 'N' },
  { id: 'edge', glyph: '⁄', label: 'Add edge', shortcut: 'E' },
  { id: 'lasso', glyph: '◌', label: 'Lasso select', shortcut: 'L' },
  { id: 'pan', glyph: '✥', label: 'Pan view', shortcut: 'H' },
  { id: 'occluder', glyph: '⬠', label: 'Draw occluder from nodes', shortcut: 'O' },
  { id: 'reference', glyph: '▩', label: 'Move reference image', shortcut: 'R' },
];

interface PickDefinition {
  mode: SelectionMode;
  glyph: string;
  label: string;
}

/** What the pointer may grab. Edges-only is how you reach an edge under nodes. */
const PICK_MODES: PickDefinition[] = [
  { mode: 'both', glyph: '◈', label: 'Select nodes and edges' },
  { mode: 'nodes', glyph: '•', label: 'Select nodes only' },
  { mode: 'edges', glyph: '∕', label: 'Select edges only (marquee and lasso sweep edges)' },
];

export interface ToolbarCallbacks {
  onFitProject: () => void;
  onResetView: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onExportPng: () => void;
}

export class Toolbar {
  private store: EditorStore;
  element: HTMLElement;
  private buttons = new Map<ToolId, HTMLButtonElement>();
  private snapButton: HTMLButtonElement;
  private gridButton: HTMLButtonElement;
  private occluderButton: HTMLButtonElement;
  private pickButtons = new Map<SelectionMode, HTMLButtonElement>();

  constructor(store: EditorStore, callbacks: ToolbarCallbacks) {
    this.store = store;

    const toolButtons = TOOLS.map((tool) => {
      const element = h(
        'button',
        {
          class: 'tool',
          type: 'button',
          title: `${tool.label} (${tool.shortcut})`,
          on: { click: () => this.store.setTool(tool.id) },
        },
        [h('span', { class: 'tool-glyph', text: tool.glyph })],
      );
      this.buttons.set(tool.id, element);
      return element;
    });

    this.snapButton = h('button', {
      class: 'tool',
      type: 'button',
      title: 'Snap to nearby nodes',
      on: {
        click: () => this.store.updateSnapping({ enabled: !this.store.state.snapping.enabled }),
      },
    });
    this.snapButton.appendChild(h('span', { class: 'tool-glyph', text: '⊹' }));

    this.gridButton = h('button', {
      class: 'tool',
      type: 'button',
      title: 'Show grid',
      on: { click: () => this.store.updateGrid({ visible: !this.store.state.grid.visible }) },
    });
    this.gridButton.appendChild(h('span', { class: 'tool-glyph', text: '▦' }));

    this.occluderButton = h('button', {
      class: 'tool',
      type: 'button',
      title: 'Show occluder polygons',
      on: { click: () => this.store.setShowOccluders(!this.store.state.showOccluders) },
    });
    this.occluderButton.appendChild(h('span', { class: 'tool-glyph', text: '◇' }));

    const pickButtons = PICK_MODES.map((pick) => {
      const element = h(
        'button',
        {
          class: 'tool',
          type: 'button',
          title: pick.label,
          on: { click: () => this.store.setSelectionMode(pick.mode) },
        },
        [h('span', { class: 'tool-glyph', text: pick.glyph })],
      );
      this.pickButtons.set(pick.mode, element);
      return element;
    });

    this.element = h('div', { class: 'rail' }, [
      h('div', { class: 'rail-group' }, toolButtons),
      h('div', { class: 'rail-divider' }),
      h('div', { class: 'rail-group' }, pickButtons),
      h('div', { class: 'rail-divider' }),
      h('div', { class: 'rail-group' }, [this.snapButton, this.gridButton, this.occluderButton]),
      h('div', { class: 'rail-divider' }),
      h('div', { class: 'rail-group' }, [
        this.iconButton('＋', 'Zoom in', callbacks.onZoomIn),
        this.iconButton('－', 'Zoom out', callbacks.onZoomOut),
        this.iconButton('⛶', 'Fit project in view (0)', callbacks.onFitProject),
        this.iconButton('⌂', 'Reset view to 100%', callbacks.onResetView),
      ]),
      h('div', { class: 'rail-divider' }),
      h('div', { class: 'rail-group' }, [
        this.iconButton('⤓', 'Export canvas as PNG', callbacks.onExportPng),
      ]),
    ]);

    store.subscribe((changes) => {
      if (changes.has('tool') || changes.has('view') || changes.has('occluders')) this.render();
    });
    this.render();
  }

  private iconButton(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
    return h(
      'button',
      { class: 'tool tool-quiet', type: 'button', title, on: { click: onClick } },
      [h('span', { class: 'tool-glyph', text: glyph })],
    );
  }

  private render(): void {
    for (const [id, element] of this.buttons) {
      element.classList.toggle('is-active', this.store.state.tool === id);
    }
    this.snapButton.classList.toggle('is-active', this.store.state.snapping.enabled);
    this.gridButton.classList.toggle('is-active', this.store.state.grid.visible);
    this.occluderButton.classList.toggle('is-active', this.store.state.showOccluders);
    for (const [mode, element] of this.pickButtons) {
      element.classList.toggle('is-active', this.store.state.selectionMode === mode);
    }
  }
}
