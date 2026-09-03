import type { EditorStore } from '../state/EditorStore.ts';
import { h, button, clear, field } from '../utils/dom.ts';

export interface InspectorCallbacks {
  onUploadReference: (file: File) => void;
  onClearReference: () => void;
  onFitReference: () => void;
  onResetReference: () => void;
}

const SOURCE = 'inspector';

/**
 * Context panel. Rebuilds on selection/data change but ignores its own edits
 * (via the change `source`), so typing in a field never yanks the caret away.
 */
export class Inspector {
  private store: EditorStore;
  private callbacks: InspectorCallbacks;
  element: HTMLElement;
  private body: HTMLElement;
  private titleElement: HTMLElement;

  constructor(store: EditorStore, callbacks: InspectorCallbacks) {
    this.store = store;
    this.callbacks = callbacks;
    this.titleElement = h('h2', { class: 'panel-title', text: 'Project' });
    this.body = h('div', { class: 'panel-body' });
    this.element = h('aside', { class: 'inspector' }, [
      h('header', { class: 'panel-header' }, [this.titleElement]),
      this.body,
    ]);

    store.subscribe((changes, source) => {
      if (source === SOURCE) return;
      // Frame ticks during playback must not rebuild the panel 60 times a second.
      if (source === 'raf') return;
      if (
        changes.has('selection') ||
        changes.has('topology') ||
        changes.has('settings') ||
        changes.has('reference') ||
        changes.has('view') ||
        changes.has('positions') ||
        changes.has('poses')
      ) {
        this.render();
      }
    });
    this.render();
  }

  render(): void {
    const { selectedNodeIds, selectedEdgeIds } = this.store.state;
    clear(this.body);

    if (selectedNodeIds.length === 1 && selectedEdgeIds.length === 0) {
      this.titleElement.textContent = 'Node';
      this.renderNode(selectedNodeIds[0]!);
    } else if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 1) {
      this.titleElement.textContent = 'Edge';
      this.renderEdge(selectedEdgeIds[0]!);
    } else if (selectedNodeIds.length + selectedEdgeIds.length > 1) {
      this.titleElement.textContent = 'Multiple selection';
      this.renderMultiple();
    } else {
      this.titleElement.textContent = 'Project';
      this.renderProject();
    }
  }

  private section(title: string, children: HTMLElement[]): HTMLElement {
    return h('section', { class: 'section' }, [
      h('h3', { class: 'section-title', text: title }),
      ...children,
    ]);
  }

  private numberInput(
    value: number,
    onChange: (value: number) => void,
    options: { min?: number; max?: number; step?: number } = {},
  ): HTMLInputElement {
    const input = h('input', {
      class: 'input',
      type: 'number',
      value: Number.isFinite(value) ? Number(value.toFixed(4)) : 0,
      min: options.min,
      max: options.max,
      step: options.step ?? 0.001,
    });
    input.addEventListener('change', () => {
      const parsed = Number.parseFloat(input.value);
      if (Number.isFinite(parsed)) onChange(parsed);
    });
    return input;
  }

  private slider(
    value: number,
    onInput: (value: number) => void,
    options: { min: number; max: number; step: number },
  ): HTMLElement {
    const input = h('input', {
      class: 'slider',
      type: 'range',
      value,
      min: options.min,
      max: options.max,
      step: options.step,
    });
    const readout = h('span', { class: 'readout', text: formatNumber(value) });
    input.addEventListener('input', () => {
      const parsed = Number.parseFloat(input.value);
      readout.textContent = formatNumber(parsed);
      onInput(parsed);
    });
    return h('div', { class: 'slider-row' }, [input, readout]);
  }

  private toggle(label: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
    const input = h('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'toggle' }, [input, h('span', { text: label })]);
  }

  private colorInput(value: string, onChange: (value: string) => void): HTMLElement {
    const input = h('input', { class: 'color', type: 'color', value });
    input.addEventListener('input', () => onChange(input.value));
    return input;
  }

  /* -------------------------------- node ------------------------------ */

  private renderNode(nodeId: string): void {
    const node = this.store.nodeById(nodeId);
    if (!node) {
      this.renderProject();
      return;
    }
    const position = this.store.positionOf(nodeId);

    const nameInput = h('input', { class: 'input', type: 'text', value: node.name });
    nameInput.addEventListener('change', () =>
      this.store.updateNode(nodeId, { name: nameInput.value }, SOURCE),
    );

    const idField = h('input', { class: 'input input-readonly', type: 'text', value: node.id });
    idField.readOnly = true;

    this.body.appendChild(
      this.section('Identity', [
        field('Name', nameInput),
        field('ID', idField, 'Stable identifier, preserved through export and import'),
      ]),
    );

    this.body.appendChild(
      this.section('Position in this pose', [
        field(
          'X',
          this.numberInput(position.x, (value) =>
            this.store.setNodePosition(nodeId, { x: value, y: this.store.positionOf(nodeId).y }, SOURCE),
          ),
        ),
        field(
          'Y',
          this.numberInput(position.y, (value) =>
            this.store.setNodePosition(nodeId, { x: this.store.positionOf(nodeId).x, y: value }, SOURCE),
          ),
        ),
        h('p', {
          class: 'hint',
          text: `Normalized 0–1. Editing only affects “${this.store.activePose.name}”.`,
        }),
      ]),
    );

    this.body.appendChild(
      this.section('Connections', [
        h('p', {
          class: 'hint',
          text: `${this.store.state.project.edges.filter((edge) => edge.from === nodeId || edge.to === nodeId).length} connected edges`,
        }),
        button('Delete node', () => this.store.deleteSelection(), { class: 'btn btn-danger' }),
      ]),
    );
  }

  /* -------------------------------- edge ------------------------------ */

  private renderEdge(edgeId: string): void {
    const edge = this.store.edgeById(edgeId);
    if (!edge) {
      this.renderProject();
      return;
    }
    const fromName = this.store.nodeById(edge.from)?.name ?? edge.from;
    const toName = this.store.nodeById(edge.to)?.name ?? edge.to;

    this.body.appendChild(
      this.section('Connects', [
        field('From', readOnlyInput(fromName)),
        field('To', readOnlyInput(toName)),
      ]),
    );

    this.body.appendChild(
      this.section('Appearance', [
        field(
          'Width',
          this.slider(edge.width, (value) => this.store.updateEdge(edgeId, { width: value }, SOURCE), {
            min: 0.2,
            max: 12,
            step: 0.1,
          }),
        ),
        field(
          'Brightness',
          this.slider(
            edge.brightness,
            (value) => this.store.updateEdge(edgeId, { brightness: value }, SOURCE),
            { min: 0, max: 2, step: 0.05 },
          ),
        ),
        field(
          'Noise seed',
          this.numberInput(edge.seed, (value) => this.store.updateEdge(edgeId, { seed: value }, SOURCE), {
            step: 1,
          }),
          'Keeps this edge’s glow variation identical between sessions',
        ),
      ]),
    );

    this.body.appendChild(
      this.section('Actions', [
        button('Delete edge', () => this.store.deleteSelection(), { class: 'btn btn-danger' }),
      ]),
    );
  }

  /* ------------------------------ multiple ---------------------------- */

  private renderMultiple(): void {
    const { selectedNodeIds, selectedEdgeIds } = this.store.state;
    this.body.appendChild(
      this.section('Selection', [
        h('p', {
          class: 'hint',
          text: `${selectedNodeIds.length} nodes, ${selectedEdgeIds.length} edges selected.`,
        }),
        selectedNodeIds.length >= 2
          ? h('p', {
              class: 'hint',
              text: 'Drag the box on the stage to move, its corners to scale, the top handle to rotate. Hold Shift for a uniform scale.',
            })
          : h('p', { class: 'hint', text: 'Select two or more nodes to get a transform box.' }),
      ]),
    );

    this.body.appendChild(
      this.section('Nudge', [
        h('div', { class: 'button-row' }, [
          button('← 1%', () => this.nudge(-0.01, 0)),
          button('→ 1%', () => this.nudge(0.01, 0)),
          button('↑ 1%', () => this.nudge(0, -0.01)),
          button('↓ 1%', () => this.nudge(0, 0.01)),
        ]),
      ]),
    );

    this.body.appendChild(
      this.section('Actions', [
        button('Delete selection', () => this.store.deleteSelection(), { class: 'btn btn-danger' }),
      ]),
    );
  }

  private nudge(dx: number, dy: number): void {
    const store = this.store;
    store.beginTransaction('Nudge selection');
    const next: Record<string, { x: number; y: number }> = {};
    for (const id of store.state.selectedNodeIds) {
      const position = store.positionOf(id);
      next[id] = { x: position.x + dx, y: position.y + dy };
    }
    store.setNodePositions(next, SOURCE);
    store.endTransaction(['positions']);
  }

  /* ------------------------------- project ---------------------------- */

  private renderProject(): void {
    const state = this.store.state;
    const settings = state.project.settings;

    this.body.appendChild(
      this.section('Artwork', [
        field(
          'Width',
          this.numberInput(settings.width, (value) => this.store.updateSettings({ width: value }, SOURCE), {
            min: 1,
            step: 1,
          }),
        ),
        field(
          'Height',
          this.numberInput(settings.height, (value) => this.store.updateSettings({ height: value }, SOURCE), {
            min: 1,
            step: 1,
          }),
        ),
        h('p', {
          class: 'hint',
          text: `${state.project.nodes.length} nodes · ${state.project.edges.length} edges · ${state.project.poses.length} poses`,
        }),
      ]),
    );

    this.body.appendChild(
      this.section('Animation', [
        field(
          'Duration (s)',
          this.numberInput(
            settings.duration,
            (value) => this.store.updateSettings({ duration: value }, SOURCE),
            { min: 0.1, step: 0.1 },
          ),
        ),
        this.toggle('Loop playback', settings.loop, (value) =>
          this.store.updateSettings({ loop: value }, SOURCE),
        ),
        this.toggle('Show nodes in preview', settings.showPreviewNodes, (value) =>
          this.store.updateSettings({ showPreviewNodes: value }, SOURCE),
        ),
      ]),
    );

    this.body.appendChild(
      this.section('Colour', [
        field('Line', this.colorInput(settings.lineColor, (value) =>
          this.store.updateSettings({ lineColor: value }, SOURCE),
        )),
        field('Glow', this.colorInput(settings.glowColor, (value) =>
          this.store.updateSettings({ glowColor: value }, SOURCE),
        )),
        field('Background', this.colorInput(settings.backgroundColor, (value) =>
          this.store.updateSettings({ backgroundColor: value }, SOURCE),
        )),
      ]),
    );

    this.body.appendChild(this.referenceSection());

    this.body.appendChild(
      this.section('Onion skins', [
        this.toggle('Previous pose (cyan)', state.onion.showPrevious, (value) =>
          this.store.updateOnion({ showPrevious: value }, SOURCE),
        ),
        this.toggle('Next pose (magenta)', state.onion.showNext, (value) =>
          this.store.updateOnion({ showNext: value }, SOURCE),
        ),
        this.toggle('Show ghost nodes', state.onion.showNodes, (value) =>
          this.store.updateOnion({ showNodes: value }, SOURCE),
        ),
        field(
          'Opacity',
          this.slider(state.onion.opacity, (value) => this.store.updateOnion({ opacity: value }, SOURCE), {
            min: 0.05,
            max: 0.9,
            step: 0.05,
          }),
        ),
      ]),
    );

    this.body.appendChild(
      this.section('Grid and snapping', [
        this.toggle('Show grid', state.grid.visible, (value) =>
          this.store.updateGrid({ visible: value }, SOURCE),
        ),
        this.toggle('Snapping on', state.snapping.enabled, (value) =>
          this.store.updateSnapping({ enabled: value }, SOURCE),
        ),
        this.toggle('Snap to nodes', state.snapping.toNodes, (value) =>
          this.store.updateSnapping({ toNodes: value }, SOURCE),
        ),
        this.toggle('Snap to grid', state.snapping.toGrid, (value) =>
          this.store.updateSnapping({ toGrid: value }, SOURCE),
        ),
        field(
          'Snap distance (px)',
          this.slider(
            state.snapping.threshold,
            (value) => this.store.updateSnapping({ threshold: value }, SOURCE),
            { min: 2, max: 40, step: 1 },
          ),
        ),
        field(
          'Grid size (px)',
          this.slider(
            state.snapping.gridSize,
            (value) => this.store.updateSnapping({ gridSize: value }, SOURCE),
            { min: 5, max: 200, step: 5 },
          ),
        ),
      ]),
    );
  }

  private referenceSection(): HTMLElement {
    const reference = this.store.state.reference;
    const fileInput = h('input', {
      type: 'file',
      class: 'visually-hidden',
      attrs: { accept: 'image/png,image/jpeg,image/webp' },
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) this.callbacks.onUploadReference(file);
      fileInput.value = '';
    });

    const children: HTMLElement[] = [
      fileInput,
      button('Upload reference image', () => fileInput.click(), {
        class: 'btn btn-wide',
        title: 'PNG, JPEG or WebP',
      }),
    ];

    if (reference.src) {
      children.push(
        this.toggle('Show reference', reference.visible, (value) =>
          this.store.updateReference({ visible: value }, SOURCE),
        ),
        this.toggle('Lock reference', reference.locked, (value) =>
          this.store.updateReference({ locked: value }, SOURCE),
        ),
        field(
          'Opacity',
          this.slider(
            reference.opacity,
            (value) => this.store.updateReference({ opacity: value }, SOURCE),
            { min: 0, max: 1, step: 0.05 },
          ),
        ),
        field(
          'Scale',
          this.slider(
            reference.scale,
            (value) => this.store.updateReference({ scale: value }, SOURCE),
            { min: 0.05, max: 4, step: 0.01 },
          ),
        ),
        h('div', { class: 'button-row' }, [
          button('Fit to project', () => this.callbacks.onFitReference()),
          button('Reset transform', () => this.callbacks.onResetReference()),
        ]),
        button('Remove reference', () => this.callbacks.onClearReference(), { class: 'btn btn-danger' }),
        h('p', {
          class: 'hint',
          text: reference.locked
            ? 'Locked. Unlock to drag the image on the stage.'
            : 'Unlocked. Drag the image on the stage to reposition it.',
        }),
      );
    } else {
      children.push(
        h('p', { class: 'hint', text: 'No reference loaded. Tracing works fine without one.' }),
      );
    }

    return this.section('Reference image', children);
  }
}

function readOnlyInput(value: string): HTMLInputElement {
  const input = h('input', { class: 'input input-readonly', type: 'text', value });
  input.readOnly = true;
  return input;
}

function formatNumber(value: number): string {
  return Math.abs(value) >= 10 ? value.toFixed(0) : value.toFixed(2);
}
