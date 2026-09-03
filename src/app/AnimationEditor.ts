import { EditorStore } from '../state/EditorStore.ts';
import { KonvaEditor } from '../editor/KonvaEditor.ts';
import { PreviewRenderer } from '../preview/PreviewRenderer.ts';
import { AppShell } from './AppShell.ts';
import { Toolbar } from '../ui/Toolbar.ts';
import { Inspector } from '../ui/Inspector.ts';
import { ImageDropTarget } from './ImageDropTarget.ts';
import { PartsPanel } from '../ui/PartsPanel.ts';
import { PoseTimeline } from '../ui/PoseTimeline.ts';
import { PlaybackControls } from '../ui/PlaybackControls.ts';
import { ShortcutsDialog } from '../ui/ShortcutsDialog.ts';
import {
  downloadProject,
  exportFilename,
  loadProjectFromStorage,
  loadReferenceImageFromStorage,
  loadReferenceImageNameFromStorage,
  parseProject,
  readFileAsDataUrl,
  readFileAsText,
  saveProjectToStorage,
  saveReferenceImageToStorage,
} from '../model/serialization.ts';
import type { SelectionMode, ToolId } from '../model/types.ts';
import { advanceTime } from '../preview/interpolation.ts';
import { button, downloadDataUrl, isTypingTarget } from '../utils/dom.ts';

const DEFAULT_REFERENCE = 'reference-bird.png';

/** Composition root: owns the store and connects every subsystem to it. */
export class AnimationEditor {
  /** Exposed so hosts (and tests) can observe the authoritative state. */
  readonly store: EditorStore;
  private shell: AppShell;
  private editor: KonvaEditor;
  private preview: PreviewRenderer;
  private shortcuts: ShortcutsDialog;
  private editClockHandle: number | null = null;
  private lastClockTimestamp = 0;

  constructor(root: HTMLElement) {
    this.store = new EditorStore();
    this.shortcuts = new ShortcutsDialog();

    this.shell = new AppShell(this.store, {
      onUndo: () => this.undo(),
      onRedo: () => this.redo(),
      onExport: () => this.exportProject(),
      onImport: (file) => void this.importProject(file),
      onSave: () => this.saveToBrowser(),
      onLoad: () => this.loadFromBrowser(),
      onReset: () => this.resetProject(),
      onShortcuts: () => this.shortcuts.toggle(),
    });

    root.appendChild(this.shell.element);
    root.appendChild(this.shortcuts.element);

    this.editor = new KonvaEditor(this.shell.konvaHost, this.store);
    this.preview = new PreviewRenderer(this.shell.previewCanvas, this.store);

    const toolbar = new Toolbar(this.store, {
      onFitProject: () => this.editor.fitProject(),
      onResetView: () => this.editor.resetView(),
      onZoomIn: () => this.editor.zoomBy(1.2),
      onZoomOut: () => this.editor.zoomBy(1 / 1.2),
      onExportPng: () => this.exportPng(),
    });
    this.shell.railSlot.appendChild(toolbar.element);

    // Dropping an image anywhere in the editor is the same action as the
    // inspector's upload button, so both go through uploadReference.
    new ImageDropTarget(root, {
      onFile: (file) => void this.uploadReference(file),
      onNotice: (message) => this.store.setStatus(message, 'info'),
    });

    const inspector = new Inspector(this.store, {
      onUploadReference: (file) => void this.uploadReference(file),
      onClearReference: () => this.clearReference(),
      onFitReference: () => this.editor.reference.fitToProject(),
      onResetReference: () => this.editor.reference.resetTransform(),
    });
    this.shell.inspectorSlot.appendChild(new PartsPanel(this.store).element);
    this.shell.inspectorSlot.appendChild(inspector.element);

    const timeline = new PoseTimeline(this.store);
    this.shell.timelineSlot.appendChild(timeline.element);

    const previewControls = new PlaybackControls(this.store, { compact: true });
    this.shell.previewControlsSlot.append(
      previewControls.element,
      button('Edit', () => this.store.setMode('edit'), {
        class: 'btn btn-accent',
        title: 'Back to Edit mode (P)',
      }),
    );

    this.store.subscribe((changes) => {
      if (changes.has('mode')) this.applyMode();
      if (changes.has('settings')) this.preview.resize();
      if (changes.has('mode') || changes.has('playback')) this.updateEditClock();
    });

    this.attachShortcuts();
    this.applyMode();
    void this.restoreSession();
    this.store.enableAutosave();
  }

  /* ------------------------------- session ---------------------------- */

  private async restoreSession(): Promise<void> {
    const stored = loadProjectFromStorage();
    if (stored?.ok) {
      this.store.replaceProject(stored.project, 'Restore autosave');
      this.store.markSaved();
      this.store.setStatus('Restored your last autosaved project.', 'success');
      this.editor.fitProject();
    }

    const storedImage = loadReferenceImageFromStorage();
    if (storedImage) {
      await this.editor.reference.load(storedImage, {
        fit: false,
        name: loadReferenceImageNameFromStorage(),
      });
      this.editor.reference.sync();
      return;
    }
    // Fall back to the bundled reference if the author dropped one in /public.
    const loaded = await this.editor.reference.load(DEFAULT_REFERENCE);
    if (!loaded) this.store.updateReference({ src: null });
  }

  /**
   * Drives playback while the Konva stage is on screen. In Preview mode the
   * renderer owns its own loop, so exactly one clock runs at a time.
   */
  private updateEditClock(): void {
    const state = this.store.state;
    const shouldRun = state.mode === 'edit' && state.playback.playing;

    if (!shouldRun) {
      if (this.editClockHandle !== null) {
        cancelAnimationFrame(this.editClockHandle);
        this.editClockHandle = null;
      }
      return;
    }
    if (this.editClockHandle !== null) return;

    this.lastClockTimestamp = performance.now();
    const step = (timestamp: number) => {
      const delta = Math.min(0.1, (timestamp - this.lastClockTimestamp) / 1000);
      this.lastClockTimestamp = timestamp;
      const settings = this.store.state.project.settings;
      const result = advanceTime(
        this.store.state.playback.time,
        delta,
        settings.duration,
        settings.loop,
      );
      this.store.state.playback.time = result.time;
      if (result.finished) {
        this.store.state.playback.playing = false;
        this.editClockHandle = null;
        this.store.emit(['playback', 'positions']);
        return;
      }
      // 'raf' marks a frame tick: panels that only care about edits ignore it.
      this.store.emit(['playback', 'positions'], 'raf');
      this.editClockHandle = requestAnimationFrame(step);
    };
    this.editClockHandle = requestAnimationFrame(step);
  }

  private applyMode(): void {
    const mode = this.store.state.mode;
    this.editor.setVisible(mode === 'edit');
    this.shell.previewHost.style.display = mode === 'preview' ? '' : 'none';
    if (mode === 'preview') {
      this.preview.resize();
      this.preview.start();
    } else {
      this.preview.stop();
    }
  }

  /* ------------------------------ commands ---------------------------- */

  private undo(): void {
    if (!this.store.undo()) this.store.setStatus('Nothing left to undo.', 'info');
  }

  private redo(): void {
    if (!this.store.redo()) this.store.setStatus('Nothing left to redo.', 'info');
  }

  private exportProject(): void {
    downloadProject(this.store.state.project);
    this.store.setStatus('Exported the project as JSON.', 'success');
  }

  private exportPng(): void {
    const dataUrl =
      this.store.state.mode === 'preview' ? this.preview.exportDataUrl() : this.editor.exportDataUrl();
    downloadDataUrl(dataUrl, `${exportFilename().replace(/\.json$/, '')}.png`);
    this.store.setStatus('Exported the canvas as PNG.', 'success');
  }

  private async importProject(file: File): Promise<void> {
    try {
      const text = await readFileAsText(file);
      const result = parseProject(text);
      if (!result.ok) {
        this.store.setStatus(`Import failed. ${result.errors.slice(0, 2).join(' ')}`, 'error');
        return;
      }
      this.store.replaceProject(result.project, 'Import project');
      this.editor.fitProject();
      const warning = result.warnings.length > 0 ? ` ${result.warnings.length} item(s) were repaired.` : '';
      this.store.setStatus(`Imported ${file.name}.${warning}`, 'success');
    } catch (error) {
      this.store.setStatus(error instanceof Error ? error.message : 'Import failed.', 'error');
    }
  }

  private saveToBrowser(): void {
    if (saveProjectToStorage(this.store.state.project)) {
      this.store.markSaved();
      this.store.setStatus('Saved to this browser.', 'success');
    } else {
      this.store.setStatus('Could not save. Browser storage is full or blocked.', 'error');
    }
  }

  private loadFromBrowser(): void {
    const result = loadProjectFromStorage();
    if (!result) {
      this.store.setStatus('No project is stored in this browser yet.', 'error');
      return;
    }
    if (!result.ok) {
      this.store.setStatus(`Stored project is invalid. ${result.errors[0] ?? ''}`, 'error');
      return;
    }
    this.store.replaceProject(result.project, 'Load from browser');
    this.editor.fitProject();
    this.store.setStatus('Loaded the stored project.', 'success');
  }

  private resetProject(): void {
    if (!this.store.isEmptyProject) {
      const confirmed = window.confirm(
        'Reset the project? Every node, edge and pose will be cleared. This can be undone with Ctrl/Cmd + Z.',
      );
      if (!confirmed) return;
    }
    this.store.resetProject();
    this.editor.fitProject();
    this.store.setStatus('Project reset.', 'info');
  }

  private async uploadReference(file: File): Promise<void> {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      this.store.setStatus('Reference images must be PNG, JPEG or WebP.', 'error');
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const loaded = await this.editor.reference.load(dataUrl, { name: file.name });
      if (!loaded) {
        this.store.setStatus('That image could not be decoded.', 'error');
        return;
      }
      saveReferenceImageToStorage(dataUrl, file.name);
      this.store.setStatus(`Reference set to ${file.name}.`, 'success');
    } catch (error) {
      this.store.setStatus(error instanceof Error ? error.message : 'Upload failed.', 'error');
    }
  }

  private clearReference(): void {
    this.editor.reference.clear();
    saveReferenceImageToStorage(null);
    this.store.setStatus('Reference image removed.', 'info');
  }

  /* ------------------------------ shortcuts --------------------------- */

  /** Q steps through nodes+edges, nodes only, edges only. */
  private cycleSelectionMode(): void {
    const order: SelectionMode[] = ['both', 'nodes', 'edges'];
    const next = order[(order.indexOf(this.store.state.selectionMode) + 1) % order.length]!;
    this.store.setSelectionMode(next);
    const label =
      next === 'both' ? 'nodes and edges' : next === 'nodes' ? 'nodes only' : 'edges only';
    this.store.setStatus(`Selecting ${label}.`, 'info');
  }

  private attachShortcuts(): void {
    const toolKeys: Record<string, ToolId> = {
      v: 'select',
      n: 'node',
      e: 'edge',
      l: 'lasso',
      h: 'pan',
      o: 'occluder',
    };

    window.addEventListener('keydown', (event) => {
      if (isTypingTarget(event.target)) return;

      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (modifier && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (modifier && key === 'y') {
        event.preventDefault();
        this.redo();
        return;
      }
      if (modifier) return;

      if (event.code === 'Space') {
        event.preventDefault();
        this.editor.setSpaceDown(true);
        return;
      }
      if (key === 'escape') {
        this.shortcuts.close();
        this.editor.handleEscape();
        return;
      }
      if (key === 'enter') {
        // Closes an in-progress occluder polygon.
        if (this.editor.commitActiveTool()) event.preventDefault();
        return;
      }
      if (key === 'delete' || key === 'backspace') {
        event.preventDefault();
        if (this.store.state.selectedOccluderId) {
          this.store.removeOccluder(this.store.state.selectedOccluderId);
        } else {
          this.store.deleteSelection();
        }
        return;
      }
      if (key === '0') {
        this.editor.fitProject();
        return;
      }
      if (key === 'q') {
        this.cycleSelectionMode();
        return;
      }
      if (key === 'p') {
        this.store.setMode(this.store.state.mode === 'edit' ? 'preview' : 'edit');
        return;
      }
      if (key === '?' || (key === '/' && event.shiftKey)) {
        this.shortcuts.toggle();
        return;
      }
      const tool = toolKeys[key];
      if (tool) this.store.setTool(tool);
    });

    window.addEventListener('keyup', (event) => {
      if (event.code === 'Space') this.editor.setSpaceDown(false);
    });

    window.addEventListener('blur', () => this.editor.setSpaceDown(false));

    window.addEventListener('beforeunload', (event) => {
      if (!this.store.state.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }
}
