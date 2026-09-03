// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { PlaybackControls } from '../src/ui/PlaybackControls.ts';
import { EditorStore } from '../src/state/EditorStore.ts';

/**
 * PlaybackControls pulls in no Konva, so the real transport mounts in jsdom and
 * the scrub gestures can be driven end to end.
 */
function mount() {
  const store = new EditorStore();
  const controls = new PlaybackControls(store);
  document.body.appendChild(controls.element);
  const scrubber = controls.element.querySelector<HTMLInputElement>('.scrubber')!;
  return { store, controls, scrubber };
}

/** Drag the handle to `ratio` of the duration, without releasing it. */
function dragTo(scrubber: HTMLInputElement, ratio: number): void {
  scrubber.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
  scrubber.value = String(ratio);
  scrubber.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function release(scrubber: HTMLInputElement): void {
  scrubber.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true }));
  scrubber.dispatchEvent(new window.Event('change', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('scrubbing while the animation is playing', () => {
  it('pauses as soon as the handle is grabbed', () => {
    const { store, scrubber } = mount();
    store.setPlaying(true);
    scrubber.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
    expect(store.state.playback.playing).toBe(false);
    expect(store.state.playback.scrubbing).toBe(true);
  });

  it('stays paused for the whole drag', () => {
    const { store, scrubber } = mount();
    store.setPlaying(true);
    dragTo(scrubber, 0.25);
    dragTo(scrubber, 0.5);
    expect(store.state.playback.playing).toBe(false);
  });

  it('resumes on release, from wherever the handle was left', () => {
    const { store, scrubber } = mount();
    store.setPlaying(true);
    dragTo(scrubber, 0.5);
    release(scrubber);

    expect(store.state.playback.playing).toBe(true);
    expect(store.state.playback.scrubbing).toBe(false);
    expect(store.state.playback.time).toBeCloseTo(store.state.project.settings.duration * 0.5, 4);
  });

  it('keeps showing interpolated geometry across the whole gesture', () => {
    // Both flags feed isPreviewingTimeline. If it ever went false mid-gesture
    // the stage would blink back to the authored pose.
    const { store, scrubber } = mount();
    store.setPlaying(true);
    const seen: boolean[] = [];
    store.subscribe(() => seen.push(store.isPreviewingTimeline));

    dragTo(scrubber, 0.4);
    release(scrubber);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });
});

describe('scrubbing while the animation is paused', () => {
  it('leaves it paused on release', () => {
    const { store, scrubber } = mount();
    expect(store.state.playback.playing).toBe(false);
    dragTo(scrubber, 0.5);
    release(scrubber);
    expect(store.state.playback.playing).toBe(false);
  });

  it('still moves the playhead', () => {
    const { store, scrubber } = mount();
    dragTo(scrubber, 0.25);
    release(scrubber);
    expect(store.state.playback.time).toBeCloseTo(store.state.project.settings.duration * 0.25, 4);
  });
});

describe('scrub bookkeeping', () => {
  it('does not let a second pointerdown overwrite the remembered state', () => {
    // The bug this guards: a repeated pointerdown mid-drag would record the
    // paused state this very scrub imposed, and playback would never resume.
    const { store, scrubber } = mount();
    store.setPlaying(true);
    scrubber.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
    scrubber.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
    release(scrubber);
    expect(store.state.playback.playing).toBe(true);
  });

  it('closes a drag released outside the slider, where no pointerup arrives', () => {
    const { store, scrubber } = mount();
    store.setPlaying(true);
    dragTo(scrubber, 0.5);
    scrubber.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(store.state.playback.scrubbing).toBe(false);
    expect(store.state.playback.playing).toBe(true);
  });

  it('ignores a release that was never preceded by a scrub', () => {
    const { store, scrubber } = mount();
    store.setPlaying(true);
    release(scrubber);
    expect(store.state.playback.playing).toBe(true);
  });

  it('pauses for a keyboard scrub too, which raises input with no pointerdown', () => {
    const { store, scrubber } = mount();
    store.setPlaying(true);
    scrubber.value = '0.3';
    scrubber.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(store.state.playback.playing).toBe(false);
    scrubber.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(store.state.playback.playing).toBe(true);
  });
});
