export interface ImageDropCallbacks {
  /** Called with the dropped image file. */
  onFile: (file: File) => void;
  /** Called with an informational message about the drop itself. */
  onNotice: (message: string) => void;
}

/** Class toggled on the root while a file drag is over the editor. */
export const DROP_ACTIVE_CLASS = 'is-drop-target';

/**
 * Whole-window image drop.
 *
 * Dropping a file anywhere in the editor routes it to the same handler as the
 * "Upload reference image" button, so validation and error reporting live in
 * one place. The file type is deliberately *not* re-checked here: the shared
 * handler already rejects anything that is not PNG, JPEG or WebP, and a second
 * copy of that rule would be one more thing to keep in sync.
 */
export class ImageDropTarget {
  private root: HTMLElement;
  private callbacks: ImageDropCallbacks;
  /**
   * Depth counter, not a boolean. `dragleave` fires every time the pointer
   * crosses into a child element, so a boolean would flicker the overlay off
   * as soon as the drag moved over the canvas or a panel.
   */
  private depth = 0;

  constructor(root: HTMLElement, callbacks: ImageDropCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    root.addEventListener('dragenter', this.onDragEnter);
    root.addEventListener('dragover', this.onDragOver);
    root.addEventListener('dragleave', this.onDragLeave);
    root.addEventListener('drop', this.onDrop);
  }

  destroy(): void {
    this.root.removeEventListener('dragenter', this.onDragEnter);
    this.root.removeEventListener('dragover', this.onDragOver);
    this.root.removeEventListener('dragleave', this.onDragLeave);
    this.root.removeEventListener('drop', this.onDrop);
    this.setActive(false);
  }

  /** True when the drag is carrying files rather than selected text or a link. */
  private carriesFiles(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    return Array.prototype.includes.call(types, 'Files');
  }

  private setActive(active: boolean): void {
    if (!active) this.depth = 0;
    this.root.classList.toggle(DROP_ACTIVE_CLASS, active);
  }

  private onDragEnter = (event: DragEvent): void => {
    if (!this.carriesFiles(event)) return;
    event.preventDefault();
    this.depth += 1;
    this.setActive(true);
  };

  private onDragOver = (event: DragEvent): void => {
    if (!this.carriesFiles(event)) return;
    // Without preventDefault on dragover the drop never fires and the browser
    // navigates away to the file instead.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  private onDragLeave = (event: DragEvent): void => {
    if (!this.carriesFiles(event)) return;
    this.depth = Math.max(0, this.depth - 1);
    if (this.depth === 0) this.setActive(false);
  };

  private onDrop = (event: DragEvent): void => {
    if (!this.carriesFiles(event)) return;
    event.preventDefault();
    this.setActive(false);

    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    // Prefer an image when several files come at once; otherwise hand the first
    // one over anyway so the shared handler reports why it was refused.
    const file = files.find((entry) => entry.type.startsWith('image/')) ?? files[0]!;
    if (files.length > 1 && file.type.startsWith('image/')) {
      this.callbacks.onNotice(`Several files dropped — using ${file.name}.`);
    }
    this.callbacks.onFile(file);
  };
}
