import type { EditorStore } from '../state/EditorStore.ts';
import type { GraphEdge, GraphNode } from '../model/types.ts';
import { h, button, clear, field } from '../utils/dom.ts';
import { validateOccluders } from '../model/occluders.ts';
import { interpolationLabel } from '../preview/interpolation.ts';

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
        changes.has('poses') ||
        changes.has('parts') ||
        changes.has('occluders')
      ) {
        this.render();
      }
    });
    this.render();
  }

  render(): void {
    const { selectedNodeIds, selectedEdgeIds, selectedOccluderId } = this.store.state;
    clear(this.body);

    if (selectedOccluderId) {
      this.titleElement.textContent = 'Occluder';
      this.renderOccluder(selectedOccluderId);
    } else if (selectedNodeIds.length === 1 && selectedEdgeIds.length === 0) {
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

  private section(title: string, children: HTMLElement[], note?: string | null): HTMLElement {
    return h('section', { class: 'section' }, [
      h('h3', { class: 'section-title' }, [
        h('span', { class: 'section-title-text', text: title }),
        // Kept dimmer than the title itself, and ellipsised: a long file name
        // must not push the heading wider than the inspector.
        note ? h('span', { class: 'section-title-note', text: `(${note})`, title: note }) : null,
      ]),
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

  /**
   * A slider whose whole drag is one undo step.
   *
   * `input` fires on every tick, so without a transaction each pixel of travel
   * pushed its own history entry and undo crawled back through the drag one
   * frame at a time. The gesture opens on the first tick and closes on
   * `change`, which fires once when the handle is released — including a
   * release outside the control, where no pointerup arrives here.
   */
  private slider(
    value: number,
    onInput: (value: number) => void,
    options: { min: number; max: number; step: number; undoLabel?: string },
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
    let dragging = false;

    input.addEventListener('input', () => {
      const parsed = Number.parseFloat(input.value);
      readout.textContent = formatNumber(parsed);
      if (!dragging) {
        dragging = true;
        this.store.beginTransaction(options.undoLabel ?? 'Adjust value');
      }
      onInput(parsed);
    });
    const settle = () => {
      if (!dragging) return;
      dragging = false;
      this.store.endTransaction(['topology', 'settings']);
    };
    input.addEventListener('change', settle);
    // A keyboard user may never fire `change` before tabbing away.
    input.addEventListener('blur', settle);

    return h('div', { class: 'slider-row' }, [input, readout]);
  }

  private toggle(label: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
    const input = h('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'toggle' }, [input, h('span', { text: label })]);
  }

  private interpolationSelect(): HTMLSelectElement {
    const current = this.store.state.project.settings.interpolation;
    const select = h('select', { class: 'input' });
    for (const mode of ['linear', 'catmull-rom'] as const) {
      const option = h('option', { value: mode, text: interpolationLabel(mode) });
      option.selected = mode === current;
      select.appendChild(option);
    }
    select.addEventListener('change', () =>
      this.store.updateSettings(
        { interpolation: select.value === 'linear' ? 'linear' : 'catmull-rom' },
        SOURCE,
      ),
    );
    return select;
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
    const editable = this.store.isNodeInteractive(nodeId);

    const nameInput = h('input', {
      class: 'input',
      type: 'text',
      value: node.name,
      disabled: !editable,
    });
    nameInput.addEventListener('change', () =>
      this.store.updateNode(nodeId, { name: nameInput.value }, SOURCE),
    );

    const idField = h('input', { class: 'input input-readonly', type: 'text', value: node.id });
    idField.readOnly = true;

    const identity: HTMLElement[] = [
      field('Name', nameInput),
      field('ID', idField, 'Stable identifier, preserved through export and import'),
      field(
        'Part',
        this.partSelect(
          node.partId,
          (partId) => this.store.setNodePart(nodeId, partId, SOURCE),
          !editable,
        ),
        'The render layer this node belongs to',
      ),
    ];
    const nodeNotice = this.lockedNotice(node.partId);
    if (nodeNotice) identity.push(nodeNotice);
    this.body.appendChild(this.section('Identity', identity));

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
      this.section('Appearance', [
        ...this.appearanceFields(
          [node],
          (patch) => this.store.updateNode(nodeId, patch, SOURCE),
          'node',
        ),
        h('p', {
          class: 'hint',
          text: 'Size and glow of this node in the rendered animation. Turn brightness to 0 to leave it out of the output entirely.',
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
    const editable = this.store.isEdgeInteractive(edgeId);

    const connects: HTMLElement[] = [
      field('From', readOnlyInput(fromName)),
      field('To', readOnlyInput(toName)),
      field(
        'Part',
        this.partSelect(
          edge.partId,
          (partId) => this.store.setEdgePart(edgeId, partId, SOURCE),
          !editable,
        ),
        'Decides the render layer, even when the two nodes sit in other parts',
      ),
    ];
    const edgeNotice = this.lockedNotice(edge.partId);
    if (edgeNotice) connects.push(edgeNotice);
    this.body.appendChild(this.section('Connects', connects));

    this.body.appendChild(
      this.section('Appearance', [
        ...this.appearanceFields(
          [edge],
          (patch) => this.store.updateEdge(edgeId, patch, SOURCE),
          'edge',
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

    const selectedNodes = selectedNodeIds
      .map((id) => this.store.nodeById(id))
      .filter((node): node is GraphNode => Boolean(node));
    if (selectedNodes.length > 0) {
      this.body.appendChild(
        this.section(
          'Node appearance',
          this.appearanceFields(
            selectedNodes,
            (patch) => this.store.updateNodes(selectedNodeIds, patch, SOURCE),
            'node',
          ),
        ),
      );
    }

    const selectedEdges = selectedEdgeIds
      .map((id) => this.store.edgeById(id))
      .filter((edge): edge is GraphEdge => Boolean(edge));
    if (selectedEdges.length > 0) {
      this.body.appendChild(
        this.section(
          'Edge appearance',
          this.appearanceFields(
            selectedEdges,
            (patch) => this.store.updateEdges(selectedEdgeIds, patch, SOURCE),
            'edge',
          ),
        ),
      );
    }

    this.body.appendChild(
      this.section('Part', [
        field(
          'Move selection to',
          this.partSelect(this.store.state.activePartId, (partId) =>
            this.store.assignSelectionToPart(partId, SOURCE),
          ),
          'Reassigns every selected node and edge',
        ),
      ]),
    );

    this.body.appendChild(
      this.section('Actions', [
        button('Delete selection', () => this.store.deleteSelection(), { class: 'btn btn-danger' }),
      ]),
    );
  }

  /**
   * Width and brightness controls for one or many nodes or edges.
   *
   * Each slider starts at the shared value when the items agree, and at their
   * mean when they do not — a mean is a fair place to drag from, and the hint
   * says so rather than pretending the selection is uniform.
   */
  private appearanceFields(
    items: { width: number; brightness: number }[],
    apply: (patch: { width?: number; brightness?: number }) => void,
    noun: string,
  ): HTMLElement[] {
    const summarise = (
      read: (item: { width: number; brightness: number }) => number,
    ): { value: number; mixed: boolean } => {
      const values = items.map(read);
      const first = values[0] ?? 0;
      const mixed = values.some((value) => value !== first);
      const mean = values.reduce((total, value) => total + value, 0) / (values.length || 1);
      return { value: mixed ? mean : first, mixed };
    };

    const width = summarise((item) => item.width);
    const brightness = summarise((item) => item.brightness);

    const fields: HTMLElement[] = [
      field(
        'Width',
        this.slider(width.value, (value) => apply({ width: value }), {
          min: 0.2,
          max: 12,
          step: 0.1,
        }),
      ),
      field(
        'Brightness',
        this.slider(brightness.value, (value) => apply({ brightness: value }), {
          min: 0,
          max: 2,
          step: 0.05,
        }),
      ),
    ];

    if (items.length > 1) {
      fields.push(
        h('p', {
          class: 'hint',
          text:
            width.mixed || brightness.mixed
              ? `These ${items.length} ${noun}s differ; a slider shows their average and sets them all.`
              : `Applies to all ${items.length} selected ${noun}s.`,
        }),
      );
    }
    return fields;
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
        this.toggle('Node markers in preview', settings.showPreviewNodes, (value) =>
          this.store.updateSettings({ showPreviewNodes: value }, SOURCE),
        ),
        h('p', {
          class: 'hint',
          text: 'A flat placement overlay, drawn on top at one size. Node size and glow in the artwork itself come from each node’s own appearance.',
        }),
        field('Interpolation', this.interpolationSelect()),
        field(
          'Smoothing',
          this.slider(
            settings.tension,
            (value) => this.store.updateSettings({ tension: value }, SOURCE),
            { min: 0, max: 1, step: 0.05 },
          ),
          'Tangent strength in smooth mode. 0 eases through every pose with no overshoot.',
        ),
        h('p', {
          class: 'hint',
          text:
            settings.interpolation === 'catmull-rom'
              ? 'Smooth mode passes exactly through every authored pose and wraps at the loop seam.'
              : 'Linear mode blends straight between poses through an ease-in-out curve.',
        }),
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

    this.body.appendChild(this.occluderSection());

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


  /* -------------------------------- parts ----------------------------- */

  /** Part chooser used by the node and edge inspectors. */
  private partSelect(
    selectedPartId: string,
    onChange: (partId: string) => void,
    disabled = false,
  ): HTMLSelectElement {
    const select = h('select', { class: 'input', disabled }) as HTMLSelectElement;
    for (const part of this.store.partsInOrder) {
      const option = h('option', { value: part.id, text: part.name }) as HTMLOptionElement;
      option.selected = part.id === selectedPartId;
      select.appendChild(option);
    }
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  private lockedNotice(partId: string): HTMLElement | null {
    const part = this.store.partById(partId);
    if (!part || !this.store.partStateOf(partId).locked) return null;
    return h('p', {
      class: 'hint hint-warn',
      text: `“${part.name}” is locked. Unlock it in the Parts panel to edit this.`,
    });
  }

  /* ------------------------------ occluder ---------------------------- */

  private renderOccluder(occluderId: string): void {
    const occluder = this.store.state.project.occluders.find((entry) => entry.id === occluderId);
    if (!occluder) {
      this.store.selectOccluder(null);
      this.renderProject();
      return;
    }
    const editable = this.store.isOccluderInteractive(occluderId);

    const nameInput = h('input', {
      class: 'input',
      type: 'text',
      value: occluder.name,
      disabled: !editable,
    });
    nameInput.addEventListener('change', () =>
      this.store.updateOccluder(occluderId, { name: nameInput.value.trim() || occluder.name }, SOURCE),
    );

    const identity: HTMLElement[] = [
      field('Name', nameInput),
      field(
        'Owner part',
        this.partSelect(
          occluder.ownerPartId,
          (partId) => this.store.updateOccluder(occluderId, { ownerPartId: partId }, SOURCE),
          !editable,
        ),
        'The silhouette this mask belongs to',
      ),
      this.toggle('Enabled', occluder.enabled, (value) =>
        this.store.updateOccluder(occluderId, { enabled: value }, SOURCE),
      ),
    ];
    const notice = this.lockedNotice(occluder.ownerPartId);
    if (notice) identity.push(notice);
    this.body.appendChild(this.section('Occluder', identity));

    /* Targets: which parts this mask erases. */
    const targets = this.store.partsInOrder
      .filter((part) => part.id !== occluder.ownerPartId)
      .map((part) =>
        this.toggle(part.name, occluder.targetPartIds.includes(part.id), () =>
          this.store.toggleOccluderTarget(occluderId, part.id),
        ),
      );
    this.body.appendChild(
      this.section('Masks these parts', [
        ...(targets.length > 0
          ? targets
          : [h('p', { class: 'hint', text: 'No other parts to mask yet.' })]),
        h('p', {
          class: 'hint',
          text: 'Erased with destination-out in Preview, so glow disappears with the lines.',
        }),
      ]),
    );

    this.body.appendChild(
      this.section('Mask', [
        field(
          'Expansion (px)',
          this.slider(
            occluder.maskExpansion,
            (value) => this.store.updateOccluder(occluderId, { maskExpansion: value }, SOURCE),
            { min: 0, max: 20, step: 0.5 },
          ),
          'Grows the mask outward so glow cannot leak across the silhouette',
        ),
      ]),
    );

    /* Ordered boundary nodes, with reorder and remove. */
    const rows = occluder.boundaryNodeIds.map((nodeId, index) => {
      const node = this.store.nodeById(nodeId);
      return h('div', { class: 'boundary-row' }, [
        h('span', { class: 'boundary-index', text: String(index + 1) }),
        h('span', { class: 'boundary-name', text: node?.name ?? `Missing (${nodeId})` }),
        h('button', {
          class: 'part-move',
          type: 'button',
          text: '↑',
          title: 'Move earlier in the polygon',
          disabled: index === 0 || !editable,
          on: { click: () => this.store.moveOccluderBoundaryNode(occluderId, nodeId, -1) },
        }),
        h('button', {
          class: 'part-move',
          type: 'button',
          text: '↓',
          title: 'Move later in the polygon',
          disabled: index === occluder.boundaryNodeIds.length - 1 || !editable,
          on: { click: () => this.store.moveOccluderBoundaryNode(occluderId, nodeId, 1) },
        }),
        h('button', {
          class: 'part-move part-delete',
          type: 'button',
          text: '×',
          title: 'Remove this node from the boundary',
          disabled: !editable,
          on: { click: () => this.store.removeOccluderBoundaryNode(occluderId, nodeId) },
        }),
      ]);
    });

    const issues = validateOccluders(this.store.state.project).filter(
      (issue) => issue.occluderId === occluderId,
    );

    this.body.appendChild(
      this.section('Boundary', [
        ...rows,
        h('div', { class: 'button-row' }, [
          button('Reverse order', () => this.store.reverseOccluderBoundary(occluderId), {
            title: 'Flip the winding direction',
          }),
        ]),
        ...issues.map((issue) => h('p', { class: 'hint hint-warn', text: issue.message })),
        h('p', {
          class: 'hint',
          text: 'The polygon closes automatically from the last node back to the first.',
        }),
      ]),
    );

    this.body.appendChild(
      this.section('Actions', [
        button('Delete occluder', () => this.store.removeOccluder(occluderId), {
          class: 'btn btn-danger',
        }),
      ]),
    );
  }

  /** Occluder list shown on the project panel. */
  private occluderSection(): HTMLElement {
    const occluders = this.store.state.project.occluders;
    const children: HTMLElement[] = [
      this.toggle('Show occluders on the stage', this.store.state.showOccluders, (value) =>
        this.store.setShowOccluders(value),
      ),
    ];

    if (occluders.length === 0) {
      children.push(
        h('p', {
          class: 'hint',
          text: 'None yet. Pick the Occluder tool (O), click boundary nodes in order, then press Enter.',
        }),
      );
    } else {
      for (const occluder of occluders) {
        const targetNames = occluder.targetPartIds
          .map((partId) => this.store.partById(partId)?.name ?? partId)
          .join(', ');
        children.push(
          h('div', { class: 'occluder-row' }, [
            h('button', {
              class: 'occluder-name',
              type: 'button',
              text: occluder.enabled ? occluder.name : `${occluder.name} (off)`,
              title: `Masks: ${targetNames || 'nothing'}`,
              on: { click: () => this.store.selectOccluder(occluder.id) },
            }),
            h('span', { class: 'occluder-meta', text: `${occluder.boundaryNodeIds.length} pts` }),
          ]),
        );
      }
    }
    return this.section('Occluders', children);
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
          text: 'Pick the Reference tool (R) in the left rail to drag the image into place.',
        }),
      );
    } else {
      children.push(
        h('p', { class: 'hint', text: 'No reference loaded. Tracing works fine without one.' }),
      );
    }

    return this.section('Reference image', children, reference.src ? reference.name : null);
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
