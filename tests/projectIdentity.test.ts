// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { EditorStore } from '../src/state/EditorStore.ts';
import { AppShell } from '../src/app/AppShell.ts';
import {
  DEFAULT_PROJECT_NAME,
  createEmptyProject,
} from '../src/model/projectFactory.ts';
import {
  exportFilename,
  filenameSlug,
  parseProject,
  serializeProject,
} from '../src/model/serialization.ts';
import { validateProject } from '../src/runtime/validate.ts';

beforeEach(() => {
  document.body.innerHTML = '';
});

/** The shell with every callback stubbed; only the name field is under test. */
function shell(store: EditorStore) {
  const element = new AppShell(store, {
    onUndo: () => {},
    onRedo: () => {},
    onExport: () => {},
    onImport: () => {},
    onSave: () => {},
    onLoad: () => {},
    onNewProject: () => {},
    onShortcuts: () => {},
  }).element;
  document.body.appendChild(element);
  return element.querySelector<HTMLInputElement>('.project-name')!;
}

describe('the project name', () => {
  it('starts out as an untitled new project', () => {
    expect(createEmptyProject().name).toBe(DEFAULT_PROJECT_NAME);
    expect(DEFAULT_PROJECT_NAME).toBe('New project');
  });

  it('is renamed through the store, as one undoable step', () => {
    const store = new EditorStore();
    store.setProjectName('Walk cycle');
    expect(store.state.project.name).toBe('Walk cycle');
    expect(store.undo()).toBe(true);
    expect(store.state.project.name).toBe(DEFAULT_PROJECT_NAME);
  });

  it('falls back to the default rather than going blank', () => {
    const store = new EditorStore();
    store.setProjectName('Walk cycle');
    store.setProjectName('   ');
    expect(store.state.project.name).toBe(DEFAULT_PROJECT_NAME);
  });

  it('round trips through export and import', () => {
    const store = new EditorStore();
    store.setProjectName('Walk cycle');
    const result = parseProject(serializeProject(store.state.project));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.name).toBe('Walk cycle');
  });

  it('opens a file written before names existed as untitled', () => {
    const project = JSON.parse(serializeProject(createEmptyProject())) as Record<string, unknown>;
    delete project.name;
    const result = validateProject(project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.name).toBe(DEFAULT_PROJECT_NAME);
    // A missing name is normal for an old file, not something to report.
    expect(result.warnings.join(' ')).not.toMatch(/name/i);
  });

  it('is edited in the top bar and pushed to the store', () => {
    const store = new EditorStore();
    const input = shell(store);
    expect(input.value).toBe(DEFAULT_PROJECT_NAME);

    input.value = 'Walk cycle';
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(store.state.project.name).toBe('Walk cycle');
  });

  it('follows a rename that came from somewhere else, such as an import', () => {
    const store = new EditorStore();
    const input = shell(store);
    const imported = createEmptyProject();
    imported.name = 'Imported rig';
    store.replaceProject(imported, 'Import project');
    expect(input.value).toBe('Imported rig');
  });
});

describe('export filenames', () => {
  it('names the file after the project', () => {
    expect(exportFilename('Walk cycle')).toMatch(/^walk-cycle-\d{8}-\d{4}\.json$/);
    expect(exportFilename('Walk cycle', 'png')).toMatch(/^walk-cycle-\d{8}-\d{4}\.png$/);
  });

  it('reduces a name to something every filesystem accepts', () => {
    expect(filenameSlug('Walk cycle')).toBe('walk-cycle');
    expect(filenameSlug('  Bird / Wing v2.1  ')).toBe('bird-wing-v2-1');
    // All punctuation would otherwise leave the download called just ".json".
    expect(filenameSlug('***')).toBe('project');
    expect(filenameSlug('')).toBe('project');
    expect(filenameSlug('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('starting a new project', () => {
  it('discards the geometry, the poses, the settings and the name', () => {
    const store = new EditorStore();
    store.setProjectName('Walk cycle');
    const a = store.addNodeAt({ x: 0.2, y: 0.2 });
    const b = store.addNodeAt({ x: 0.4, y: 0.4 });
    store.addEdgeBetween(a, b);
    store.addPoseAfterActive();
    store.updateSettings({ duration: 9 });

    store.newProject();

    expect(store.state.project.name).toBe(DEFAULT_PROJECT_NAME);
    expect(store.state.project.nodes).toHaveLength(0);
    expect(store.state.project.edges).toHaveLength(0);
    expect(store.state.project.poses).toHaveLength(1);
    expect(store.state.project.settings.duration).toBe(4);
    expect(store.state.project.parts).toHaveLength(1);
  });

  it('stays undoable, so a misfire is recoverable', () => {
    const store = new EditorStore();
    store.addNodeAt({ x: 0.2, y: 0.2 });
    store.newProject();
    expect(store.undo()).toBe(true);
    expect(store.state.project.nodes).toHaveLength(1);
  });
});
