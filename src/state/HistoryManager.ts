/**
 * Snapshot history. Each entry is a full deep copy of the document-relevant
 * state (project + active pose + selection). That is plenty for this first
 * iteration: a 200-node / 500-edge project snapshots in well under a
 * millisecond, and it removes an entire class of patch-inversion bugs.
 *
 * Camera, hover and tool changes are intentionally *not* snapshotted.
 */
export const HISTORY_LIMIT = 100;

export class HistoryManager<T> {
  private past: T[] = [];
  private future: T[] = [];
  private limit: number;
  private labels: string[] = [];

  constructor(limit = HISTORY_LIMIT) {
    this.limit = limit;
  }

  /** Called with the state as it was *before* a mutation. */
  push(snapshot: T, label = 'edit'): void {
    this.past.push(snapshot);
    this.labels.push(label);
    if (this.past.length > this.limit) {
      this.past.shift();
      this.labels.shift();
    }
    this.future.length = 0;
  }

  undo(current: T): T | null {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.labels.pop();
    this.future.push(current);
    return previous;
  }

  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    this.labels.push('redo');
    return next;
  }

  /**
   * Discards the newest redo entry. Used when an operation turned out to be a
   * no-op and was rolled back internally: the user never saw it happen, so it
   * must not become something they can redo.
   */
  dropRedo(): void {
    this.future.pop();
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get size(): number {
    return this.past.length;
  }

  get lastLabel(): string | null {
    return this.labels[this.labels.length - 1] ?? null;
  }

  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
    this.labels.length = 0;
  }
}
