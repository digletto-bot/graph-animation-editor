// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorStore } from '../src/state/EditorStore.ts';
import { addPart, cloneProject, createEmptyProject } from '../src/model/projectFactory.ts';

/**
 * jsdom ships no localStorage and the storage helpers swallow the error, so the
 * round trip needs a stub to assert against.
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

/** A project whose parts are not the placeholder's single `part-1`. */
function projectWithParts() {
  const project = createEmptyProject();
  addPart(project, 'Wing');
  return project;
}

beforeEach(() => {
  memoryStorage.clear();
  vi.useFakeTimers();
});

describe('editor state that must survive a reload', () => {
  it('restores lock/hide/solo/xray for parts the placeholder project never had', () => {
    const project = projectWithParts();
    const wingId = project.parts[project.parts.length - 1]!.id;

    // Session one: a project is open, and a part is locked and hidden.
    const first = new EditorStore(project);
    first.updatePartDisplay(wingId, { locked: true, hidden: true });
    vi.runAllTimers();

    // Session two: the store boots on the placeholder, then the autosave lands.
    const second = new EditorStore();
    expect(second.state.project.parts).toHaveLength(1);
    // The autosave restores the same document, so part ids are unchanged.
    second.replaceProject(cloneProject(project), 'Restore autosave');

    const restored = second.state.partDisplay[wingId];
    expect(restored?.locked).toBe(true);
    expect(restored?.hidden).toBe(true);
  });

  it('restores the selected pose', () => {
    const project = projectWithParts();
    const first = new EditorStore(project);
    first.addPoseAfterActive();
    const chosen = first.state.activePoseId;
    expect(chosen).not.toBe(project.poses[0]!.id);
    vi.runAllTimers();

    const second = new EditorStore();
    second.replaceProject(project, 'Restore autosave');
    expect(second.state.activePoseId).toBe(project.poses[0]!.id);
    second.restoreActivePose();
    expect(second.state.activePoseId).toBe(chosen);
  });

  it('leaves the default selection alone when the stored pose is gone', () => {
    const first = new EditorStore(projectWithParts());
    first.addPoseAfterActive();
    vi.runAllTimers();

    const fresh = projectWithParts();
    const second = new EditorStore();
    second.replaceProject(fresh, 'Restore autosave');
    second.restoreActivePose();
    expect(second.state.activePoseId).toBe(fresh.poses[0]!.id);
  });
});
