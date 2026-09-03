import type { EditorStore } from '../state/EditorStore.ts';
import { h } from '../utils/dom.ts';

const SOURCE = 'playback-controls';

/** Transport shared by the edit timeline and the preview overlay. */
export class PlaybackControls {
  private store: EditorStore;
  element: HTMLElement;
  private playButton: HTMLButtonElement;
  private loopButton: HTMLButtonElement;
  private scrubber: HTMLInputElement;
  private timeLabel: HTMLElement;

  constructor(store: EditorStore, options: { compact?: boolean } = {}) {
    this.store = store;

    this.playButton = h('button', {
      class: 'transport-btn transport-primary',
      type: 'button',
      title: 'Play / pause',
      text: '▶',
      on: { click: () => this.store.setPlaying(!this.store.state.playback.playing) },
    });

    const restartButton = h('button', {
      class: 'transport-btn',
      type: 'button',
      title: 'Restart',
      text: '↺',
      on: {
        click: () => {
          this.store.setPlaybackTime(0, SOURCE);
          this.render();
        },
      },
    });

    this.loopButton = h('button', {
      class: 'transport-btn',
      type: 'button',
      title: 'Loop',
      text: '⟳',
      on: {
        click: () =>
          this.store.updateSettings({ loop: !this.store.state.project.settings.loop }, SOURCE),
      },
    });

    this.scrubber = h('input', {
      class: 'scrubber',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.001,
      value: 0,
    });
    this.scrubber.addEventListener('pointerdown', () => this.store.setScrubbing(true));
    this.scrubber.addEventListener('pointerup', () => this.store.setScrubbing(false));
    this.scrubber.addEventListener('input', () => {
      const value = Number.parseFloat(this.scrubber.value);
      this.store.setScrubbing(true);
      this.store.setPlaybackTime(value * this.store.state.project.settings.duration, SOURCE);
      this.updateTimeLabel();
    });
    this.scrubber.addEventListener('change', () => this.store.setScrubbing(false));

    this.timeLabel = h('span', { class: 'time-label', text: '0.00s' });

    this.element = h('div', { class: options.compact ? 'transport transport-compact' : 'transport' }, [
      this.playButton,
      restartButton,
      this.loopButton,
      this.scrubber,
      this.timeLabel,
    ]);

    store.subscribe((changes, source) => {
      if (changes.has('playback') || changes.has('settings') || changes.has('poses')) {
        if (source === SOURCE && changes.has('playback')) {
          this.updateTimeLabel();
          return;
        }
        this.render();
      }
    });
    this.render();
  }

  private updateTimeLabel(): void {
    const { time } = this.store.state.playback;
    const duration = this.store.state.project.settings.duration;
    this.timeLabel.textContent = `${time.toFixed(2)}s / ${duration.toFixed(2)}s`;
  }

  render(): void {
    const state = this.store.state;
    this.playButton.textContent = state.playback.playing ? '❚❚' : '▶';
    this.playButton.classList.toggle('is-active', state.playback.playing);
    this.loopButton.classList.toggle('is-active', state.project.settings.loop);
    const duration = Math.max(0.001, state.project.settings.duration);
    const ratio = state.playback.time / duration;
    if (document.activeElement !== this.scrubber) this.scrubber.value = String(ratio);
    this.updateTimeLabel();
  }
}
