// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from 'canvas';

/**
 * Mounts the *real* application in jsdom with a native canvas backend. This is
 * the only test that exercises the Konva stage, the DOM shell and all the
 * store subscriptions wired together, so it catches construction-time breakage
 * that the pure-logic tests cannot.
 */
beforeAll(() => {
  // Back jsdom's canvas elements with node-canvas so Konva can render.
  const proto = window.HTMLCanvasElement.prototype as unknown as {
    getContext: (type: string) => unknown;
  };
  proto.getContext = function getContext(this: HTMLCanvasElement, type: string) {
    const backing = createCanvas(this.width || 300, this.height || 150);
    return type === '2d' ? backing.getContext('2d') : null;
  };

  // jsdom has no ResizeObserver and no layout, so panels report zero size.
  window.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;

  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 600, width: 900, height: 600, toJSON: () => ({}) };
  } as unknown as () => DOMRect;

  // jsdom does not implement <dialog>.
  const dialog = window.HTMLDialogElement?.prototype as unknown as Record<string, unknown>;
  if (dialog) {
    dialog.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
    dialog.close = function close(this: HTMLDialogElement) {
      this.open = false;
    };
  }
  window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16) as unknown as number) as typeof requestAnimationFrame;
  window.cancelAnimationFrame = ((handle: number) =>
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)) as typeof cancelAnimationFrame;
});

async function mount() {
  const { AnimationEditor } = await import('../src/app/AnimationEditor.ts');
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = new AnimationEditor(root);
  return { app, root };
}

describe('application mount', () => {
  it('builds the full shell without throwing', async () => {
    const { root } = await mount();
    expect(root.querySelector('.topbar')).not.toBeNull();
    expect(root.querySelector('.rail')).not.toBeNull();
    expect(root.querySelector('.inspector')).not.toBeNull();
    expect(root.querySelector('.timeline')).not.toBeNull();
    // Konva injects its own canvas into the stage host.
    expect(root.querySelector('.stage-host canvas')).not.toBeNull();
    expect(root.querySelector('.preview-canvas')).not.toBeNull();
  });

  it('starts with one pose card and the select tool active', async () => {
    const { root } = await mount();
    expect(root.querySelectorAll('.pose-card')).toHaveLength(1);
    expect(root.querySelector('.pose-name')).toHaveProperty('value', 'Pose 1');
    expect(root.querySelector('.tool.is-active')).not.toBeNull();
  });

  it('renders new pose cards when a pose is added', async () => {
    const { root } = await mount();
    const addButton = [...root.querySelectorAll('button')].find(
      (button) => button.textContent === 'Add pose',
    );
    expect(addButton).toBeDefined();
    addButton!.click();
    expect(root.querySelectorAll('.pose-card')).toHaveLength(2);
    expect(root.querySelectorAll('.pose-card.is-active')).toHaveLength(1);
  });

  it('switches between Edit and Preview mode', async () => {
    const { root } = await mount();
    const modeButtons = [...root.querySelectorAll<HTMLButtonElement>('.mode-btn')];
    const previewButton = modeButtons.find((button) => button.textContent === 'Preview')!;
    const stageHost = root.querySelector<HTMLElement>('.stage-host')!;
    const previewHost = root.querySelector<HTMLElement>('.preview-host')!;

    previewButton.click();
    expect(previewButton.classList.contains('is-active')).toBe(true);
    expect(stageHost.style.display).toBe('none');
    expect(previewHost.style.display).not.toBe('none');

    modeButtons.find((button) => button.textContent === 'Edit')!.click();
    expect(previewHost.style.display).toBe('none');
    expect(stageHost.style.display).not.toBe('none');
  });

  it('keeps keyboard shortcuts out of text inputs', async () => {
    const { root } = await mount();
    const nameInput = root.querySelector<HTMLInputElement>('.pose-name')!;
    nameInput.focus();
    nameInput.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'p', bubbles: true }),
    );
    // Typing "p" in a pose name must not flip the app into Preview mode.
    expect(root.querySelector<HTMLElement>('.preview-host')!.style.display).toBe('none');
  });

  it('opens the shortcuts dialog from the top bar', async () => {
    const { root } = await mount();
    const helpButton = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '?',
    )!;
    helpButton.click();
    const dialog = root.querySelector<HTMLDialogElement>('.dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelectorAll('.shortcut-row').length).toBeGreaterThan(10);
  });
});
