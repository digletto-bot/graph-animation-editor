import type { EditorStore } from '../state/EditorStore.ts';
import { h, button, clear } from '../utils/dom.ts';
import { PlaybackControls } from './PlaybackControls.ts';

const SOURCE = 'pose-timeline';

/**
 * Poses are shown as compact cards, not one track per node: a 200-node bird
 * would otherwise produce 200 unreadable timeline rows.
 */
export class PoseTimeline {
  private store: EditorStore;
  element: HTMLElement;
  private track: HTMLElement;
  playback: PlaybackControls;

  constructor(store: EditorStore) {
    this.store = store;
    this.track = h('div', { class: 'pose-track' });
    this.playback = new PlaybackControls(store);

    const actions = h('div', { class: 'timeline-actions' }, [
      button('Add pose', () => this.store.addPoseAfterActive(), { title: 'Copy the active pose into a new one' }),
      button('Duplicate', () => this.store.duplicateActivePose()),
      button('Delete', () => this.store.deletePoseById(this.store.state.activePoseId), {
        class: 'btn btn-danger',
      }),
      button('Distribute frames', () => this.distributeFrames(), {
        title: 'Space every pose evenly across the animation duration',
      }),
    ]);

    this.element = h('footer', { class: 'timeline' }, [
      h('div', { class: 'timeline-bar' }, [
        h('h2', { class: 'panel-title', text: 'Poses' }),
        actions,
        this.playback.element,
      ]),
      this.track,
    ]);

    store.subscribe((changes, source) => {
      if (source === SOURCE) return;
      if (changes.has('poses') || changes.has('topology') || changes.has('settings')) this.render();
    });
    this.render();
  }

  /**
   * Re-times every pose to sit evenly across the duration. Positions are never
   * touched, and it is one undoable step, so no confirmation is needed.
   */
  private distributeFrames(): void {
    if (!this.store.distributePoseTimes()) {
      this.store.setStatus('Add a second pose before distributing.', 'error');
      return;
    }
    const { poses, settings } = this.store.state.project;
    this.store.setStatus(
      `Spread ${poses.length} poses evenly across ${settings.duration}s.`,
      'success',
    );
    this.render();
  }

  render(): void {
    clear(this.track);
    const state = this.store.state;
    const poses = state.project.poses;

    poses.forEach((pose, index) => {
      const isActive = pose.id === state.activePoseId;

      const nameInput = h('input', { class: 'pose-name', type: 'text', value: pose.name });
      nameInput.addEventListener('change', () =>
        this.store.renamePose(pose.id, nameInput.value.trim() || pose.name, SOURCE),
      );
      nameInput.addEventListener('pointerdown', (event) => event.stopPropagation());

      const timeInput = h('input', {
        class: 'pose-time',
        type: 'number',
        value: pose.time.toFixed(2),
        min: 0,
        max: state.project.settings.duration,
        step: 0.05,
      });
      timeInput.addEventListener('change', () => {
        const parsed = Number.parseFloat(timeInput.value);
        if (Number.isFinite(parsed)) this.store.setPoseTime(pose.id, parsed, SOURCE);
        this.render();
      });
      timeInput.addEventListener('pointerdown', (event) => event.stopPropagation());

      const card = h(
        'div',
        {
          class: isActive ? 'pose-card is-active' : 'pose-card',
          title: `Pose ${index + 1} of ${poses.length}`,
        },
        [
          h('div', { class: 'pose-card-head' }, [
            h('span', { class: 'pose-index', text: String(index + 1) }),
            nameInput,
          ]),
          h('div', { class: 'pose-card-foot' }, [
            timeInput,
            h('span', { class: 'pose-unit', text: 's' }),
            h('div', { class: 'pose-reorder' }, [
              h('button', {
                class: 'pose-move',
                type: 'button',
                text: '‹',
                title: 'Move earlier',
                disabled: index === 0,
                on: {
                  click: (event: MouseEvent) => {
                    event.stopPropagation();
                    this.store.reorderPose(pose.id, -1);
                  },
                },
              }),
              h('button', {
                class: 'pose-move',
                type: 'button',
                text: '›',
                title: 'Move later',
                disabled: index === poses.length - 1,
                on: {
                  click: (event: MouseEvent) => {
                    event.stopPropagation();
                    this.store.reorderPose(pose.id, 1);
                  },
                },
              }),
            ]),
          ]),
        ],
      );

      card.addEventListener('pointerdown', () => this.store.setActivePose(pose.id));
      this.track.appendChild(card);
    });

    this.track.appendChild(
      h('button', {
        class: 'pose-add',
        type: 'button',
        text: '+',
        title: 'Add a pose after the active one',
        on: { click: () => this.store.addPoseAfterActive() },
      }),
    );
  }
}
