// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PoseTimeline } from '../src/ui/PoseTimeline.ts';
import { EditorStore } from '../src/state/EditorStore.ts';

/**
 * Drives the real timeline in jsdom. PoseTimeline pulls in no Konva, so it
 * mounts without a canvas backend.
 *
 * Note on scope: jsdom does not implement focus-on-mousedown at all, so "the
 * field did not take focus" cannot be observed here. What these assert is the
 * mechanism that suppresses it in a browser — that the tap is defaultPrevented
 * — plus every part of the double-tap bookkeeping, which is where the real
 * complexity lives.
 */
function mount(poseCount = 3) {
  const store = new EditorStore();
  store.addNodeAt({ x: 0.3, y: 0.3 });
  while (store.state.project.poses.length < poseCount) store.addPoseAfterActive();
  store.setActivePose(store.state.project.poses[0]!.id);
  const timeline = new PoseTimeline(store);
  document.body.appendChild(timeline.element);
  return { store, timeline };
}

function nameFieldFor(poseId: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    `.pose-card[data-pose-id="${poseId}"] .pose-name`,
  );
  if (!input) throw new Error(`No name field rendered for pose ${poseId}`);
  return input;
}

/** One tap on a pose's name field; returns whether the default was prevented. */
function tapName(poseId: string): boolean {
  const event = new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true });
  nameFieldFor(poseId).dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('single tap on a pose name', () => {
  it('is prevented, so the browser cannot move focus into the field', () => {
    const { store } = mount();
    const second = store.state.project.poses[1]!.id;
    expect(tapName(second)).toBe(true);
  });

  it('still selects the pose, because the tap reaches the card', () => {
    const { store } = mount();
    const second = store.state.project.poses[1]!.id;
    tapName(second);
    expect(store.state.activePoseId).toBe(second);
  });

  it('leaves the field unfocused once the timers have run', () => {
    const { store } = mount();
    const second = store.state.project.poses[1]!.id;
    tapName(second);
    vi.runAllTimers();
    expect(document.activeElement).not.toBe(nameFieldFor(second));
  });
});

describe('double tap on a pose name', () => {
  it('focuses the field and selects its text', () => {
    const { store } = mount();
    const first = store.state.project.poses[0]!.id;
    tapName(first);
    tapName(first);
    vi.runAllTimers();

    const input = nameFieldFor(first);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('works on an inactive pose, whose first tap rebuilds the whole track', () => {
    // Why the double tap is tracked by pose id and a timestamp rather than a
    // native dblclick listener: activating a pose re-renders every card, so the
    // two taps land on different elements and the browser would dispatch
    // dblclick on their common ancestor — the track — not on the field.
    const { store } = mount();
    const second = store.state.project.poses[1]!.id;
    const before = nameFieldFor(second);

    tapName(second); // activates pose 2 and rebuilds the track
    const after = nameFieldFor(second);
    expect(after).not.toBe(before);
    expect(before.isConnected).toBe(false);

    tapName(second);
    vi.runAllTimers();
    expect(document.activeElement).toBe(nameFieldFor(second));
  });

  it('ignores two taps spaced further apart than the double-tap window', () => {
    const { store } = mount();
    const first = store.state.project.poses[0]!.id;
    tapName(first);
    vi.advanceTimersByTime(600);
    tapName(first);
    vi.runAllTimers();
    expect(document.activeElement).not.toBe(nameFieldFor(first));
  });

  it('does not pair taps on two different poses', () => {
    const { store } = mount();
    const [a, b] = store.state.project.poses;
    tapName(a!.id);
    tapName(b!.id);
    vi.runAllTimers();
    expect(document.activeElement).not.toBe(nameFieldFor(b!.id));
  });
});

describe('once the field is being edited', () => {
  it('lets further clicks through so the caret can be placed', () => {
    const { store } = mount();
    const first = store.state.project.poses[0]!.id;
    tapName(first);
    tapName(first);
    vi.runAllTimers();

    // Focused now, so this tap must not be prevented.
    expect(tapName(first)).toBe(false);
  });

  it('commits a rename on change without rebuilding the track', () => {
    const { store } = mount();
    const first = store.state.project.poses[0]!.id;
    const input = nameFieldFor(first);
    input.value = 'Wings up';
    input.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(store.state.project.poses[0]!.name).toBe('Wings up');
    expect(nameFieldFor(first)).toBe(input);
  });
});
