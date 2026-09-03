// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DROP_ACTIVE_CLASS, ImageDropTarget } from '../src/app/ImageDropTarget.ts';

/**
 * jsdom has no DataTransfer, so drags are simulated with a plain stand-in
 * carrying the two fields the target reads: `types` and `files`.
 */
function dragEvent(type: string, files: File[] | null): Event {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: files === null ? { types: ['text/plain'], files: [] } : { types: ['Files'], files },
    configurable: true,
  });
  return event;
}

const png = (name = 'ref.png') => new File(['x'], name, { type: 'image/png' });

function mount() {
  const root = document.createElement('div');
  root.className = 'app';
  const child = document.createElement('canvas');
  root.appendChild(child);
  document.body.appendChild(root);

  const onFile = vi.fn();
  const onNotice = vi.fn();
  const target = new ImageDropTarget(root, { onFile, onNotice });
  return { root, child, onFile, onNotice, target };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('dropping an image on the editor', () => {
  it('hands the file to the upload callback', () => {
    const { root, onFile } = mount();
    const file = png();
    root.dispatchEvent(dragEvent('drop', [file]));
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it('works when the drop lands on a child, not the root', () => {
    // The whole editor is the target, so the canvas and panels must count too.
    const { child, onFile } = mount();
    const file = png();
    child.dispatchEvent(dragEvent('drop', [file]));
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it('prevents the default so the browser does not navigate to the file', () => {
    const { root } = mount();
    const drop = dragEvent('drop', [png()]);
    root.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
  });

  it('prevents the default on dragover, without which no drop ever fires', () => {
    const { root } = mount();
    const over = dragEvent('dragover', [png()]);
    root.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
  });

  it('forwards a non-image file so the shared handler reports the reason', () => {
    // Type checking lives in uploadReference; duplicating it here would be a
    // second copy of the rule to keep in sync.
    const { root, onFile } = mount();
    const pdf = new File(['x'], 'notes.pdf', { type: 'application/pdf' });
    root.dispatchEvent(dragEvent('drop', [pdf]));
    expect(onFile).toHaveBeenCalledWith(pdf);
  });

  it('picks the image out of a multi-file drop and says so', () => {
    const { root, onFile, onNotice } = mount();
    const pdf = new File(['x'], 'notes.pdf', { type: 'application/pdf' });
    const image = png('bird.png');
    root.dispatchEvent(dragEvent('drop', [pdf, image]));
    expect(onFile).toHaveBeenCalledWith(image);
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('bird.png'));
  });

  it('ignores a drag that carries no files', () => {
    const { root, onFile } = mount();
    const drop = dragEvent('drop', null);
    root.dispatchEvent(drop);
    expect(onFile).not.toHaveBeenCalled();
    expect(drop.defaultPrevented).toBe(false);
  });

  it('ignores an empty file list', () => {
    const { root, onFile } = mount();
    root.dispatchEvent(dragEvent('drop', []));
    expect(onFile).not.toHaveBeenCalled();
  });
});

describe('the drop overlay', () => {
  it('appears while a file drag is over the editor', () => {
    const { root } = mount();
    root.dispatchEvent(dragEvent('dragenter', [png()]));
    expect(root.classList.contains(DROP_ACTIVE_CLASS)).toBe(true);
  });

  it('stays up when the drag crosses into a child element', () => {
    // dragleave fires on every boundary, so a boolean flag would flicker off
    // the moment the pointer moved over the canvas.
    const { root, child } = mount();
    root.dispatchEvent(dragEvent('dragenter', [png()]));
    child.dispatchEvent(dragEvent('dragenter', [png()]));
    root.dispatchEvent(dragEvent('dragleave', [png()]));
    expect(root.classList.contains(DROP_ACTIVE_CLASS)).toBe(true);
  });

  it('goes away once the drag has fully left', () => {
    const { root, child } = mount();
    root.dispatchEvent(dragEvent('dragenter', [png()]));
    child.dispatchEvent(dragEvent('dragenter', [png()]));
    root.dispatchEvent(dragEvent('dragleave', [png()]));
    root.dispatchEvent(dragEvent('dragleave', [png()]));
    expect(root.classList.contains(DROP_ACTIVE_CLASS)).toBe(false);
  });

  it('goes away on drop', () => {
    const { root } = mount();
    root.dispatchEvent(dragEvent('dragenter', [png()]));
    root.dispatchEvent(dragEvent('drop', [png()]));
    expect(root.classList.contains(DROP_ACTIVE_CLASS)).toBe(false);
  });

  it('never appears for a drag with no files in it', () => {
    const { root } = mount();
    root.dispatchEvent(dragEvent('dragenter', null));
    expect(root.classList.contains(DROP_ACTIVE_CLASS)).toBe(false);
  });
});

describe('teardown', () => {
  it('stops listening and clears the overlay', () => {
    const { root, onFile, target } = mount();
    root.dispatchEvent(dragEvent('dragenter', [png()]));
    target.destroy();
    expect(root.classList.contains(DROP_ACTIVE_CLASS)).toBe(false);
    root.dispatchEvent(dragEvent('drop', [png()]));
    expect(onFile).not.toHaveBeenCalled();
  });
});
