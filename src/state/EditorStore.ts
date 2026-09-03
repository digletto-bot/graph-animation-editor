import type {
  AnimationProject,
  CameraState,
  EditorMode,
  EditorPreferences,
  GraphEdge,
  GraphNode,
  GridSettings,
  NodePosition,
  OnionSettings,
  Point,
  ProjectSettings,
  ReferenceDisplay,
  SelectableRef,
  SnapSettings,
  ToolId,
} from '../model/types.ts';
import {
  addEdge,
  addNode,
  addPose,
  cloneProject,
  createDefaultReference,
  createEmptyProject,
  deleteEdges,
  deleteNodes,
  deletePose,
  getPose,
  movePose,
  normalizePoseTimes,
} from '../model/projectFactory.ts';
import { HistoryManager } from './HistoryManager.ts';
import { clamp } from '../utils/coordinates.ts';
import {
  loadPreferencesFromStorage,
  savePreferencesToStorage,
  saveProjectToStorage,
} from '../model/serialization.ts';

/**
 * Node creation is restricted to the artwork area. Dragging and transforming
 * allow a small overflow so a rotate or scale near an edge does not permanently
 * squash the selection against the border.
 */
export const POSITION_SLACK = 0.25;

export type ChangeKey =
  | 'project'
  | 'topology'
  | 'positions'
  | 'settings'
  | 'poses'
  | 'selection'
  | 'camera'
  | 'mode'
  | 'tool'
  | 'playback'
  | 'view'
  | 'reference'
  | 'history'
  | 'status';

export interface PlaybackState {
  playing: boolean;
  /** Seconds. */
  time: number;
  /** True while the user drags the scrubber. */
  scrubbing: boolean;
}

export interface ReferenceState extends ReferenceDisplay {
  /** Data URL or public path. Never exported with the animation JSON. */
  src: string | null;
  naturalWidth: number;
  naturalHeight: number;
}

export interface EditorState {
  project: AnimationProject;
  mode: EditorMode;
  tool: ToolId;
  activePoseId: string;
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  hovered: SelectableRef | null;
  onion: OnionSettings;
  snapping: SnapSettings;
  grid: GridSettings;
  camera: CameraState;
  playback: PlaybackState;
  reference: ReferenceState;
  dirty: boolean;
  lastSavedAt: number | null;
  status: { message: string; tone: 'info' | 'error' | 'success' } | null;
}

interface HistorySnapshot {
  project: AnimationProject;
  activePoseId: string;
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
}

export type StoreListener = (changes: Set<ChangeKey>, source: string | undefined) => void;

export class EditorStore {
  state: EditorState;
  private listeners = new Set<StoreListener>();
  private history = new HistoryManager<HistorySnapshot>();
  private pendingSnapshot: HistorySnapshot | null = null;
  private pendingLabel = 'edit';
  private autosaveEnabled = false;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private preferencesTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `project` omitted means "start a brand new project" — in that case, saved
   * preferences (default colors + reference display) seed it. A project passed
   * explicitly (import, restore, tests) always keeps its own values instead.
   */
  constructor(project?: AnimationProject) {
    const preferences = loadPreferencesFromStorage();
    const resolvedProject = project ?? createEmptyProject();
    if (!project) {
      if (preferences?.colors) Object.assign(resolvedProject.settings, preferences.colors);
      if (preferences?.reference) {
        resolvedProject.reference = { ...createDefaultReference(), ...resolvedProject.reference, ...preferences.reference };
      }
    }

    this.state = {
      project: resolvedProject,
      mode: 'edit',
      tool: 'select',
      activePoseId: resolvedProject.poses[0]!.id,
      selectedNodeIds: [],
      selectedEdgeIds: [],
      hovered: null,
      onion: {
        showPrevious: true,
        showNext: true,
        opacity: 0.35,
        showNodes: true,
        ...preferences?.onion,
      },
      snapping: {
        enabled: true,
        toNodes: true,
        toGrid: false,
        threshold: 12,
        gridSize: 40,
        ...preferences?.snapping,
      },
      grid: { visible: false, ...preferences?.grid },
      camera: { x: 0, y: 0, scale: 1 },
      playback: { playing: false, time: 0, scrubbing: false },
      reference: {
        ...(resolvedProject.reference ?? createDefaultReference()),
        src: null,
        naturalWidth: 0,
        naturalHeight: 0,
      },
      dirty: false,
      lastSavedAt: null,
      status: null,
    };
  }

  /* ----------------------------- plumbing ----------------------------- */

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(changes: ChangeKey[], source?: string): void {
    const set = new Set(changes);
    for (const listener of [...this.listeners]) listener(set, source);
  }

  enableAutosave(): void {
    this.autosaveEnabled = true;
  }

  private scheduleAutosave(): void {
    if (!this.autosaveEnabled) return;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      if (saveProjectToStorage(this.state.project)) {
        this.state.dirty = false;
        this.state.lastSavedAt = Date.now();
        this.emit(['status']);
      }
    }, 600);
  }

  private schedulePreferencesSave(): void {
    if (this.preferencesTimer) clearTimeout(this.preferencesTimer);
    this.preferencesTimer = setTimeout(() => {
      this.preferencesTimer = null;
      const { lineColor, glowColor, backgroundColor, showPreviewNodes } = this.state.project.settings;
      const { visible, locked, opacity, scale } = this.state.reference;
      const preferences: EditorPreferences = {
        colors: { lineColor, glowColor, backgroundColor, showPreviewNodes },
        reference: { visible, locked, opacity, scale },
        onion: { ...this.state.onion },
        snapping: { ...this.state.snapping },
        grid: { ...this.state.grid },
      };
      savePreferencesToStorage(preferences);
    }, 500);
  }

  private snapshot(): HistorySnapshot {
    return {
      project: cloneProject(this.state.project),
      activePoseId: this.state.activePoseId,
      selectedNodeIds: [...this.state.selectedNodeIds],
      selectedEdgeIds: [...this.state.selectedEdgeIds],
    };
  }

  private restore(snapshot: HistorySnapshot): void {
    this.state.project = snapshot.project;
    this.state.activePoseId = this.state.project.poses.some((p) => p.id === snapshot.activePoseId)
      ? snapshot.activePoseId
      : this.state.project.poses[0]!.id;
    const nodeIds = new Set(this.state.project.nodes.map((n) => n.id));
    const edgeIds = new Set(this.state.project.edges.map((e) => e.id));
    this.state.selectedNodeIds = snapshot.selectedNodeIds.filter((id) => nodeIds.has(id));
    this.state.selectedEdgeIds = snapshot.selectedEdgeIds.filter((id) => edgeIds.has(id));
    this.state.reference = { ...this.state.reference, ...(this.state.project.reference ?? {}) };
  }

  /** Run a data mutation as a single undoable operation. */
  commit(label: string, changes: ChangeKey[], mutator: () => void, source?: string): void {
    this.history.push(this.snapshot(), label);
    mutator();
    this.state.dirty = true;
    this.emit([...changes, 'project', 'history'], source);
    this.scheduleAutosave();
  }

  /**
   * Pointer drags and transformer gestures push exactly one history entry:
   * `beginTransaction` at pointer-down, `endTransaction` at pointer-up.
   */
  beginTransaction(label: string): void {
    if (this.pendingSnapshot) return;
    this.pendingSnapshot = this.snapshot();
    this.pendingLabel = label;
  }

  endTransaction(changes: ChangeKey[] = ['positions']): void {
    if (!this.pendingSnapshot) return;
    this.history.push(this.pendingSnapshot, this.pendingLabel);
    this.pendingSnapshot = null;
    this.state.dirty = true;
    this.emit([...changes, 'project', 'history']);
    this.scheduleAutosave();
  }

  /** Abandon an in-flight gesture, restoring the pre-gesture state. */
  cancelTransaction(): void {
    if (!this.pendingSnapshot) return;
    this.restore(this.pendingSnapshot);
    this.pendingSnapshot = null;
    this.emit(['project', 'positions', 'selection']);
  }

  get hasPendingTransaction(): boolean {
    return this.pendingSnapshot !== null;
  }

  undo(): boolean {
    const previous = this.history.undo(this.snapshot());
    if (!previous) return false;
    this.restore(previous);
    this.emit(['project', 'topology', 'positions', 'poses', 'selection', 'settings', 'history', 'reference']);
    this.scheduleAutosave();
    return true;
  }

  redo(): boolean {
    const next = this.history.redo(this.snapshot());
    if (!next) return false;
    this.restore(next);
    this.emit(['project', 'topology', 'positions', 'poses', 'selection', 'settings', 'history', 'reference']);
    this.scheduleAutosave();
    return true;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  /* --------------------------- derived reads -------------------------- */

  get activePose() {
    return getPose(this.state.project, this.state.activePoseId) ?? this.state.project.poses[0]!;
  }

  get activePoseIndex(): number {
    return this.state.project.poses.findIndex((pose) => pose.id === this.state.activePoseId);
  }

  nodeById(id: string): GraphNode | undefined {
    return this.state.project.nodes.find((node) => node.id === id);
  }

  edgeById(id: string): GraphEdge | undefined {
    return this.state.project.edges.find((edge) => edge.id === id);
  }

  /** Position of a node in the active pose (or the interpolated one on playback). */
  positionOf(nodeId: string): NodePosition {
    return this.activePose.positions[nodeId] ?? { x: 0.5, y: 0.5 };
  }

  /* ------------------------------ topology ---------------------------- */

  addNodeAt(position: Point): string {
    let id = '';
    this.commit('Add node', ['topology', 'positions', 'selection'], () => {
      id = addNode(
        this.state.project,
        { x: clamp(position.x, 0, 1), y: clamp(position.y, 0, 1) },
        this.state.activePoseId,
      );
      this.state.selectedNodeIds = [id];
      this.state.selectedEdgeIds = [];
    });
    return id;
  }

  addEdgeBetween(from: string, to: string): string | null {
    let id: string | null = null;
    const before = this.state.project.edges.length;
    this.commit('Add edge', ['topology', 'selection'], () => {
      id = addEdge(this.state.project, from, to);
      if (id) {
        this.state.selectedEdgeIds = [id];
        this.state.selectedNodeIds = [];
      }
    });
    if (this.state.project.edges.length === before) {
      // Rejected (self-edge or duplicate): drop the useless history entry.
      this.undoSilently();
    }
    return id;
  }

  /** Removes the last history entry when an operation turned out to be a no-op. */
  private undoSilently(): void {
    const previous = this.history.undo(this.snapshot());
    if (previous) {
      this.restore(previous);
      this.emit(['project', 'history']);
    }
  }

  deleteSelection(): void {
    const { selectedNodeIds, selectedEdgeIds } = this.state;
    if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0) return;
    this.commit('Delete selection', ['topology', 'positions', 'selection'], () => {
      deleteEdges(this.state.project, selectedEdgeIds);
      deleteNodes(this.state.project, selectedNodeIds);
      this.state.selectedNodeIds = [];
      this.state.selectedEdgeIds = [];
    });
  }

  updateNode(id: string, patch: Partial<Omit<GraphNode, 'id'>>, source?: string): void {
    const node = this.nodeById(id);
    if (!node) return;
    this.commit('Edit node', ['topology'], () => {
      const target = this.nodeById(id)!;
      Object.assign(target, patch);
    }, source);
  }

  updateEdge(id: string, patch: Partial<Omit<GraphEdge, 'id' | 'from' | 'to'>>, source?: string): void {
    if (!this.edgeById(id)) return;
    this.commit('Edit edge', ['topology'], () => {
      Object.assign(this.edgeById(id)!, patch);
    }, source);
  }

  /* ------------------------------ positions --------------------------- */

  private clampStored(position: NodePosition): NodePosition {
    return {
      x: clamp(position.x, -POSITION_SLACK, 1 + POSITION_SLACK),
      y: clamp(position.y, -POSITION_SLACK, 1 + POSITION_SLACK),
    };
  }

  /**
   * Writes positions into the *active pose only*. No history entry — call
   * inside a transaction so a whole drag collapses to one undo step.
   */
  setNodePositions(positions: Record<string, NodePosition>, source = 'drag'): void {
    const pose = this.activePose;
    for (const id of Object.keys(positions)) {
      if (!pose.positions[id]) continue;
      pose.positions[id] = this.clampStored(positions[id]!);
    }
    this.emit(['positions'], source);
  }

  /** Single-value edit from the inspector — its own undo step. */
  setNodePosition(nodeId: string, position: NodePosition, source?: string): void {
    this.commit('Move node', ['positions'], () => {
      const pose = this.activePose;
      if (pose.positions[nodeId]) pose.positions[nodeId] = this.clampStored(position);
    }, source);
  }

  /* -------------------------------- poses ----------------------------- */

  setActivePose(poseId: string): void {
    if (this.state.activePoseId === poseId) return;
    this.state.activePoseId = poseId;
    const pose = getPose(this.state.project, poseId);
    if (pose) this.state.playback.time = pose.time;
    this.emit(['poses', 'positions', 'playback']);
  }

  addPoseAfterActive(): void {
    this.commit('Add pose', ['poses', 'positions'], () => {
      const pose = addPose(this.state.project, this.state.activePoseId);
      this.state.activePoseId = pose.id;
      this.state.playback.time = pose.time;
    });
  }

  duplicateActivePose(): void {
    this.commit('Duplicate pose', ['poses', 'positions'], () => {
      const source = this.activePose;
      const pose = addPose(this.state.project, source.id, `${source.name} copy`);
      this.state.activePoseId = pose.id;
      this.state.playback.time = pose.time;
    });
  }

  renamePose(poseId: string, name: string, source?: string): void {
    const pose = getPose(this.state.project, poseId);
    if (!pose || pose.name === name) return;
    this.commit('Rename pose', ['poses'], () => {
      getPose(this.state.project, poseId)!.name = name;
    }, source);
  }

  deletePoseById(poseId: string): boolean {
    if (this.state.project.poses.length <= 1) {
      this.setStatus('A project needs at least one pose.', 'error');
      return false;
    }
    let removed = false;
    this.commit('Delete pose', ['poses', 'positions'], () => {
      removed = deletePose(this.state.project, poseId);
      if (removed && this.state.activePoseId === poseId) {
        this.state.activePoseId = this.state.project.poses[0]!.id;
        this.state.playback.time = this.state.project.poses[0]!.time;
      }
    });
    return removed;
  }

  reorderPose(poseId: string, offset: number): void {
    this.commit('Reorder poses', ['poses', 'positions'], () => {
      movePose(this.state.project, poseId, offset);
    });
  }

  setPoseTime(poseId: string, time: number, source?: string): void {
    this.commit('Edit pose time', ['poses', 'playback'], () => {
      const pose = getPose(this.state.project, poseId);
      if (!pose) return;
      pose.time = time;
      normalizePoseTimes(this.state.project);
      this.state.playback.time = getPose(this.state.project, poseId)?.time ?? time;
    }, source);
  }

  /* ----------------------------- selection ---------------------------- */

  setSelection(nodeIds: string[], edgeIds: string[] = []): void {
    const sameNodes =
      nodeIds.length === this.state.selectedNodeIds.length &&
      nodeIds.every((id, index) => this.state.selectedNodeIds[index] === id);
    const sameEdges =
      edgeIds.length === this.state.selectedEdgeIds.length &&
      edgeIds.every((id, index) => this.state.selectedEdgeIds[index] === id);
    if (sameNodes && sameEdges) return;
    this.state.selectedNodeIds = [...nodeIds];
    this.state.selectedEdgeIds = [...edgeIds];
    this.emit(['selection']);
  }

  toggleSelection(ref: SelectableRef): void {
    const list = ref.kind === 'node' ? this.state.selectedNodeIds : this.state.selectedEdgeIds;
    const next = list.includes(ref.id) ? list.filter((id) => id !== ref.id) : [...list, ref.id];
    if (ref.kind === 'node') this.setSelection(next, this.state.selectedEdgeIds);
    else this.setSelection(this.state.selectedNodeIds, next);
  }

  clearSelection(): void {
    this.setSelection([], []);
  }

  setHovered(ref: SelectableRef | null): void {
    const current = this.state.hovered;
    if (current === ref) return;
    if (current && ref && current.kind === ref.kind && current.id === ref.id) return;
    this.state.hovered = ref;
    this.emit(['selection'], 'hover');
  }

  /* ------------------------- mode / tool / view ----------------------- */

  setMode(mode: EditorMode): void {
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    if (mode === 'edit') this.state.playback.playing = false;
    this.emit(['mode', 'playback']);
  }

  setTool(tool: ToolId): void {
    if (this.state.tool === tool) return;
    this.state.tool = tool;
    this.emit(['tool']);
  }

  setCamera(camera: CameraState): void {
    this.state.camera = camera;
    this.emit(['camera'], 'camera');
  }

  updateOnion(patch: Partial<OnionSettings>, source?: string): void {
    Object.assign(this.state.onion, patch);
    this.emit(['view'], source);
    this.schedulePreferencesSave();
  }

  updateSnapping(patch: Partial<SnapSettings>, source?: string): void {
    Object.assign(this.state.snapping, patch);
    this.emit(['view'], source);
    this.schedulePreferencesSave();
  }

  updateGrid(patch: Partial<GridSettings>, source?: string): void {
    Object.assign(this.state.grid, patch);
    this.emit(['view'], source);
    this.schedulePreferencesSave();
  }

  updateSettings(patch: Partial<ProjectSettings>, source?: string): void {
    this.commit('Project settings', ['settings', 'poses'], () => {
      Object.assign(this.state.project.settings, patch);
      if (patch.duration !== undefined) normalizePoseTimes(this.state.project);
    }, source);
    this.schedulePreferencesSave();
  }

  updateReference(patch: Partial<ReferenceState>, source?: string, withHistory = false): void {
    const apply = () => {
      Object.assign(this.state.reference, patch);
      const { visible, opacity, locked, x, y, scale } = this.state.reference;
      this.state.project.reference = { visible, opacity, locked, x, y, scale };
    };
    if (withHistory) this.commit('Reference image', ['reference'], apply, source);
    else {
      apply();
      this.emit(['reference'], source);
    }
    this.schedulePreferencesSave();
  }

  /* ------------------------------ playback ---------------------------- */

  setPlaying(playing: boolean): void {
    if (this.state.playback.playing === playing) return;
    this.state.playback.playing = playing;
    this.emit(['playback']);
  }

  setPlaybackTime(time: number, source?: string): void {
    const duration = Math.max(0.001, this.state.project.settings.duration);
    this.state.playback.time = clamp(time, 0, duration);
    this.emit(['playback', 'positions'], source);
  }

  setScrubbing(scrubbing: boolean): void {
    if (this.state.playback.scrubbing === scrubbing) return;
    this.state.playback.scrubbing = scrubbing;
    this.emit(['playback']);
  }

  /** True when the stage should show interpolated geometry instead of the pose. */
  get isPreviewingTimeline(): boolean {
    return this.state.playback.playing || this.state.playback.scrubbing;
  }

  /* ------------------------- project lifecycle ------------------------ */

  replaceProject(project: AnimationProject, label = 'Import project'): void {
    this.commit('' + label, ['topology', 'positions', 'poses', 'settings', 'selection', 'reference'], () => {
      this.state.project = project;
      this.state.activePoseId = project.poses[0]!.id;
      this.state.selectedNodeIds = [];
      this.state.selectedEdgeIds = [];
      this.state.playback.time = 0;
      this.state.playback.playing = false;
      if (project.reference) Object.assign(this.state.reference, project.reference);
    });
  }

  resetProject(): void {
    this.replaceProject(createEmptyProject(), 'Reset project');
  }

  get isEmptyProject(): boolean {
    return this.state.project.nodes.length === 0 && this.state.project.edges.length === 0;
  }

  setStatus(message: string, tone: 'info' | 'error' | 'success' = 'info'): void {
    this.state.status = { message, tone };
    this.emit(['status']);
  }

  markSaved(): void {
    this.state.dirty = false;
    this.state.lastSavedAt = Date.now();
    this.emit(['status']);
  }
}
