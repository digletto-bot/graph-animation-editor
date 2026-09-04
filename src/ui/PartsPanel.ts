import type { GraphPart, PartRole } from '../model/types.ts';
import type { EditorStore } from '../state/EditorStore.ts';
import { h, button, clear } from '../utils/dom.ts';
import { isLastPart, partDisplayOf } from '../model/parts.ts';

const SOURCE = 'parts-panel';

const ROLE_LABELS: Record<PartRole, string> = {
  'far-wing': 'Far wing',
  body: 'Body',
  'near-wing': 'Near wing',
  // Every part a project creates now is roleless; the named roles are legacy.
  other: 'Layer',
};

/**
 * Compact layers panel for Edit mode.
 *
 * Lock, hide, solo and x-ray are *editor* state: they never touch the project
 * and never create a history entry. Render (the eye-off toggle labelled "Out")
 * is the opposite — it is runtime visibility, lives in the project, and is
 * undoable.
 */
export class PartsPanel {
  private store: EditorStore;
  element: HTMLElement;
  private list: HTMLElement;

  constructor(store: EditorStore) {
    this.store = store;
    this.list = h('div', { class: 'part-list' });

    this.element = h('section', { class: 'parts-panel' }, [
      h('header', { class: 'panel-header' }, [
        h('h2', { class: 'panel-title', text: 'Parts' }),
        button('+', () => this.store.createPart(), { class: 'btn btn-mini', title: 'Add a part' }),
      ]),
      this.list,
      h('div', { class: 'part-foot' }, [
        h('p', { class: 'hint', text: 'Front of the list draws in front. Lock, hide, solo and x-ray affect this editor only.' }),
      ]),
    ]);

    store.subscribe((changes, source) => {
      // Only the rename field tags its edits with SOURCE, so that typing does
      // not rebuild the input under the caret. Every other control here must
      // repaint on its own change, so it must not use that tag.
      if (source === SOURCE || source === 'raf') return;
      if (
        changes.has('parts') ||
        changes.has('topology') ||
        changes.has('occluders') ||
        changes.has('selection')
      ) {
        this.render();
      }
    });
    this.render();
  }

  render(): void {
    clear(this.list);
    const state = this.store.state;
    // Front to back reads like a layer stack, so the panel reverses z order.
    const parts = [...this.store.partsInOrder].reverse();
    const soloing = parts.some((part) => partDisplayOf(state.partDisplay, part.id).solo);

    parts.forEach((part, index) => {
      this.list.appendChild(this.renderPart(part, index, parts.length, soloing));
    });

    if (soloing) {
      this.list.appendChild(
        button('Clear solo', () => this.store.clearSolo(), { class: 'btn btn-wide' }),
      );
    }
  }

  private renderPart(
    part: GraphPart,
    index: number,
    total: number,
    soloing: boolean,
  ): HTMLElement {
    const state = this.store.state;
    const display = partDisplayOf(state.partDisplay, part.id);
    const isActive = state.activePartId === part.id;
    const counts = this.countsFor(part.id);

    const nameInput = h('input', { class: 'part-name', type: 'text', value: part.name });
    nameInput.addEventListener('change', () =>
      this.store.renamePart(part.id, nameInput.value.trim() || part.name, SOURCE),
    );
    nameInput.addEventListener('pointerdown', (event) => event.stopPropagation());

    const row = h(
      'div',
      {
        class: isActive ? 'part-row is-active' : 'part-row',
        title: `${ROLE_LABELS[part.role]} · z ${part.zIndex}`,
      },
      [
        h('div', { class: 'part-main' }, [
          h('span', {
            class: `part-swatch part-swatch-${part.role}`,
            // The stage draws in ivory normally, so say what this colour is for
            // rather than letting the swatch imply the artwork is tinted.
            title: 'X-ray colour for this part',
          }),
          nameInput,
          h('span', { class: 'part-count', text: `${counts.nodes}n ${counts.edges}e` }),
        ]),
        h('div', { class: 'part-controls' }, [
          this.iconToggle('L', 'Lock: keep visible but not selectable', display.locked, (value) =>
            this.store.updatePartDisplay(part.id, { locked: value }),
          ),
          this.iconToggle('H', 'Hide in the editor only', display.hidden, (value) =>
            this.store.updatePartDisplay(part.id, { hidden: value }),
          ),
          this.iconToggle(
            'S',
            soloing && !display.solo ? 'Solo (other parts are soloed)' : 'Solo in the editor only',
            display.solo,
            (value) => this.store.updatePartDisplay(part.id, { solo: value }),
          ),
          this.iconToggle('X', 'X-ray: translucent overlay, always reachable', display.xray, (value) =>
            this.store.updatePartDisplay(part.id, { xray: value }),
          ),
          this.iconToggle(
            'R',
            'Render in the exported animation',
            part.renderEnabled,
            (value) => this.store.setPartRenderEnabled(part.id, value),
            'is-render',
          ),
        ]),
        h('div', { class: 'part-actions' }, [
          h('button', {
            class: 'part-move',
            type: 'button',
            text: '↑',
            title: 'Move forward',
            disabled: index === 0,
            on: {
              pointerdown: (event: PointerEvent) => event.stopPropagation(),
              click: (event: MouseEvent) => {
                event.stopPropagation();
                this.store.movePart(part.id, 1);
              },
            },
          }),
          h('button', {
            class: 'part-move',
            type: 'button',
            text: '↓',
            title: 'Move backward',
            disabled: index === total - 1,
            on: {
              pointerdown: (event: PointerEvent) => event.stopPropagation(),
              click: (event: MouseEvent) => {
                event.stopPropagation();
                this.store.movePart(part.id, -1);
              },
            },
          }),
          h('button', {
            class: 'part-move part-delete',
            type: 'button',
            text: '×',
            title: isLastPart(this.store.state.project, part.id)
              ? 'A project needs at least one part'
              : 'Delete this part (its contents must be reassigned)',
            disabled: isLastPart(this.store.state.project, part.id),
            on: {
              pointerdown: (event: PointerEvent) => event.stopPropagation(),
              click: (event: MouseEvent) => {
                event.stopPropagation();
                this.deletePart(part);
              },
            },
          }),
        ]),
      ],
    );

    row.addEventListener('pointerdown', () => this.store.setActivePart(part.id));
    return row;
  }

  private countsFor(partId: string): { nodes: number; edges: number } {
    const project = this.store.state.project;
    return {
      nodes: project.nodes.filter((node) => node.partId === partId).length,
      edges: project.edges.filter((edge) => edge.partId === partId).length,
    };
  }

  /**
   * Deleting is refused outright while the part still holds anything, unless
   * the user explicitly confirms moving those contents to another part.
   */
  private deletePart(part: GraphPart): void {
    const attempt = this.store.removePart(part.id);
    if (attempt.ok) {
      this.store.setStatus(`Deleted “${part.name}”.`, 'info');
      return;
    }
    if (attempt.reason === 'last-part') {
      this.store.setStatus('A project needs at least one part.', 'error');
      return;
    }
    if (attempt.reason !== 'not-empty') return;

    const fallback = this.store.partsInOrder.find((candidate) => candidate.id !== part.id);
    if (!fallback) return;
    const contents = attempt.contents!;
    const confirmed = window.confirm(
      `“${part.name}” still holds ${contents.nodeIds.length} node(s), ` +
        `${contents.edgeIds.length} edge(s) and ${contents.occluderIds.length} occluder reference(s).\n\n` +
        `Move them to “${fallback.name}” and delete the part?`,
    );
    if (!confirmed) return;
    const result = this.store.removePart(part.id, fallback.id);
    if (result.ok) {
      this.store.setStatus(`Moved the contents of “${part.name}” to “${fallback.name}”.`, 'success');
    }
  }

  private iconToggle(
    label: string,
    title: string,
    active: boolean,
    onChange: (value: boolean) => void,
    extraClass = '',
  ): HTMLButtonElement {
    const classes = ['part-toggle'];
    if (active) classes.push('is-on');
    if (extraClass) classes.push(extraClass);
    return h('button', {
      class: classes.join(' '),
      type: 'button',
      text: label,
      title,
      on: {
        // The row activates on pointerdown, and that re-renders the list. Without
        // this the button would be replaced before pointerup, so the click event
        // would never fire and the toggle would do nothing at all.
        pointerdown: (event: PointerEvent) => event.stopPropagation(),
        click: (event: MouseEvent) => {
          event.stopPropagation();
          onChange(!active);
        },
      },
    });
  }
}
