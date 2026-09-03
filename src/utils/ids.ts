let counter = 0;

/**
 * Stable, collision-resistant id. Array indices are never used as identifiers
 * anywhere in the project, so ids survive reordering, import and export.
 */
export function createId(prefix: string): string {
  counter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${counter.toString(36)}${random}`;
}

/** Deterministic-ish seed for new edges (stable once created). */
export function createSeed(): number {
  return Math.floor(Math.random() * 100000);
}

/** Test hook so id sequences are reproducible in unit tests. */
export function resetIdCounter(value = 0): void {
  counter = value;
}
