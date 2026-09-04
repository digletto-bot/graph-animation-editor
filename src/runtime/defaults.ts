import type { GraphPart, ProjectSettings, ReferenceDisplay } from './types.ts';
import { DEFAULT_PART_ID } from './parts.ts';

/**
 * Every default the file format itself needs.
 *
 * These are document facts, not editing behaviour: the validator fills a thin
 * or older file in with them, and the editor stamps them onto a new project.
 * They live here so both sides — and an embedding site reading an untrusted
 * file — agree on what an unspecified value means.
 */

/*
 * Node dot defaults chosen to reproduce the radius and opacity the renderer
 * used to hard-code, so an existing project looks identical after migration.
 */
/** What an untitled document is called, in the UI and in export filenames. */
export const DEFAULT_PROJECT_NAME = 'New project';

export const DEFAULT_NODE_WIDTH = 1.6;
export const DEFAULT_NODE_BRIGHTNESS = 1;
export const DEFAULT_EDGE_WIDTH = 2.4;
export const DEFAULT_EDGE_BRIGHTNESS = 1;

export function createDefaultSettings(): ProjectSettings {
  return {
    width: 1200,
    height: 800,
    duration: 4,
    loop: true,
    lineColor: '#f6efe2',
    glowColor: '#ffd9a0',
    backgroundColor: '#05060a',
    backgroundEnabled: true,
    showPreviewNodes: false,
    interpolation: 'catmull-rom',
    tension: 0.5,
  };
}

/**
 * The one layer a new project starts on. Subject matter is the author's
 * business, so nothing is presumed about what the layers are for. The id is a
 * constant rather than generated, so migration can address it directly.
 */
export function createDefaultParts(): GraphPart[] {
  return [{ id: DEFAULT_PART_ID, name: 'Part 1', role: 'other', zIndex: 0, renderEnabled: true }];
}

export function createDefaultReference(): ReferenceDisplay {
  return { visible: true, opacity: 0.4, x: 0, y: 0, scale: 1 };
}
