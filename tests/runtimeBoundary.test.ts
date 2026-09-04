import { describe, expect, it } from 'vitest';

/**
 * The runtime is the part an embedding site ships: a player, the interpolation
 * maths, the glow and masking passes, and the document types. Its whole value
 * is that it can be lifted out of this repo without dragging Konva, the store
 * or a single panel along with it.
 *
 * That property is invisible in the code — nothing fails when someone reaches
 * for `EditorStore` from inside a renderer — so it is asserted here instead.
 * Sources are read through Vite rather than the filesystem, so the suite needs
 * no node types and does not care where it is run from.
 */
const sources = import.meta.glob('../src/runtime/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const files = Object.keys(sources).sort();

/** Every module specifier a file imports from. */
function importsOf(path: string): string[] {
  return [...sources[path]!.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]!);
}

/** The file with comments removed: prose may describe what code may not do. */
function codeOf(path: string): string {
  return sources[path]!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('the runtime stands on its own', () => {
  it('has files to check, so a rename cannot quietly empty this suite', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files.some((path) => path.endsWith('/AnimationPlayer.ts'))).toBe(true);
  });

  it('imports nothing from outside src/runtime', () => {
    const escapes: string[] = [];
    for (const path of files) {
      for (const specifier of importsOf(path)) {
        // Relative and inside the folder is the only shape allowed.
        if (specifier.startsWith('./')) continue;
        escapes.push(`${path} -> ${specifier}`);
      }
    }
    expect(escapes).toEqual([]);
  });

  it('pulls in no third-party package at all, Konva above all', () => {
    const dependencies: string[] = [];
    for (const path of files) {
      for (const specifier of importsOf(path)) {
        if (specifier.startsWith('.')) continue;
        dependencies.push(`${path} -> ${specifier}`);
      }
    }
    expect(dependencies).toEqual([]);
  });

  it('keeps editor-only part display out of the shipped code', () => {
    // Lock, hide, solo and x-ray are editor state. A frame that could read them
    // would render differently in the editor than on a site.
    for (const path of files) {
      expect(codeOf(path), path).not.toMatch(/partDisplay|resolvePartState|isPreviewingTimeline/);
    }
  });
});
