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
  /** Whether playback was running when the current scrub began. */
  private resumeAfterScrub = false;

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
    this.scrubber.addEventListener('pointerdown', () => this.beginScrub());
    this.scrubber.addEventListener('pointerup', () => this.endScrub());
    this.scrubber.addEventListener('input', () => {
      const value = Number.parseFloat(this.scrubber.value);
      // Keyboard scrubbing raises `input` with no pointerdown, so the scrub has
      // to be able to start here too.
      this.beginScrub();
      this.store.setPlaybackTime(value * this.store.state.project.settings.duration, SOURCE);
      this.updateTimeLabel();
    });
    // `change` closes a drag released outside the slider, where no pointerup
    // ever reaches this element.
    this.scrubber.addEventListener('change', () => this.endScrub());

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

  /**
   * Scrubbing always pauses: letting the clock run while the handle is dragged
   * fights the user for the playhead. Whether it was playing is remembered so
   * release can pick up where they left off.
   */
  private beginScrub(): void {
    // Already mid-scrub, so the remembered state must not be overwritten with
    // the paused state this very scrub imposed.
    if (this.store.state.playback.scrubbing) return;
    this.resumeAfterScrub = this.store.state.playback.playing;
    // Scrubbing first, then pausing: both flags feed `isPreviewingTimeline`, and
    // the opposite order would blink the stage back to the authored pose.
    this.store.setScrubbing(true);
    this.store.setPlaying(false);
  }

  private endScrub(): void {
    if (!this.store.state.playback.scrubbing) return;
    const resume = this.resumeAfterScrub;
    this.resumeAfterScrub = false;
    if (resume) this.store.setPlaying(true);
    this.store.setScrubbing(false);
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
