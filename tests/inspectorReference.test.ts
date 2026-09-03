// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Inspector } from '../src/ui/Inspector.ts';
import { EditorStore } from '../src/state/EditorStore.ts';
import {
  loadReferenceImageFromStorage,
  loadReferenceImageNameFromStorage,
  saveReferenceImageToStorage,
} from '../src/model/serialization.ts';

/**
 * This jsdom setup ships no localStorage, and the storage helpers swallow the
 * resulting error by design, so a stub is needed for the round-trip cases to
 * assert anything at all.
 */
const memoryStorage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryStorage.set(key, String(value)),
    removeItem: (key: string) => void memoryStorage.delete(key),
    clear: () => memoryStorage.clear(),
  },
});

function mount() {
  const store = new EditorStore();
  const inspector = new Inspector(store, {
    onUploadReference: () => {},
    onClearReference: () => {},
    onFitReference: () => {},
    onResetReference: () => {},
  });
  document.body.appendChild(inspector.element);
  return { store, inspector };
}

/** The heading of the section whose title text is `title`. */
function heading(title: string): HTMLElement {
  const headings = [...document.querySelectorAll<HTMLElement>('.section-title')];
  const match = headings.find(
    (element) => element.querySelector('.section-title-text')?.textContent === title,
  );
  if (!match) throw new Error(`No "${title}" section rendered`);
  return match;
}

const noteIn = (element: HTMLElement) => element.querySelector<HTMLElement>('.section-title-note');

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('reference section heading', () => {
  it('names the loaded image beside the title', () => {
    const { store } = mount();
    store.updateReference({ src: 'data:image/png;base64,AAAA', name: 'example_image.png' });
    expect(noteIn(heading('Reference image'))!.textContent).toBe('(example_image.png)');
  });

  it('carries the full name as a tooltip, since the visible text is clipped', () => {
    const { store } = mount();
    const name = 'a-very-long-reference-image-file-name-that-will-not-fit.png';
    store.updateReference({ src: 'data:image/png;base64,AAAA', name });
    expect(noteIn(heading('Reference image'))!.title).toBe(name);
  });

  it('shows no note when no reference is loaded', () => {
    mount();
    expect(noteIn(heading('Reference image'))).toBeNull();
  });

  it('shows no note when the image has no known name', () => {
    const { store } = mount();
    store.updateReference({ src: 'data:image/png;base64,AAAA', name: null });
    expect(noteIn(heading('Reference image'))).toBeNull();
  });

  it('drops the note again when the reference is removed', () => {
    const { store } = mount();
    store.updateReference({ src: 'data:image/png;base64,AAAA', name: 'bird.png' });
    expect(noteIn(heading('Reference image'))).not.toBeNull();
    store.updateReference({ src: null, name: null });
    expect(noteIn(heading('Reference image'))).toBeNull();
  });

  it('leaves every other section heading a plain title', () => {
    const { store } = mount();
    store.updateReference({ src: 'data:image/png;base64,AAAA', name: 'bird.png' });
    for (const title of ['Animation', 'Colour']) {
      expect(noteIn(heading(title))).toBeNull();
    }
  });
});

describe('the reference name survives a reload', () => {
  it('round-trips through storage next to the image', () => {
    saveReferenceImageToStorage('data:image/png;base64,AAAA', 'example_image.png');
    expect(loadReferenceImageFromStorage()).toBe('data:image/png;base64,AAAA');
    expect(loadReferenceImageNameFromStorage()).toBe('example_image.png');
  });

  it('clears the name when the image is cleared', () => {
    saveReferenceImageToStorage('data:image/png;base64,AAAA', 'example_image.png');
    saveReferenceImageToStorage(null);
    expect(loadReferenceImageFromStorage()).toBeNull();
    expect(loadReferenceImageNameFromStorage()).toBeNull();
  });

  it('still loads an image stored by a build that saved no name', () => {
    // The name lives under its own key precisely so this keeps working.
    saveReferenceImageToStorage('data:image/png;base64,AAAA');
    expect(loadReferenceImageFromStorage()).toBe('data:image/png;base64,AAAA');
    expect(loadReferenceImageNameFromStorage()).toBeNull();
  });
});

describe('the reference name is editor-only state', () => {
  it('never reaches the exported project', () => {
    const { store } = mount();
    store.updateReference({ src: 'data:image/png;base64,AAAA', name: 'example_image.png' });
    expect(JSON.stringify(store.state.project)).not.toContain('example_image.png');
  });
});
