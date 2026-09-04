import type {
  AnimationProject,
  CameraState,
  EditorMode,
  EditorPreferences,
  GraphEdge,
  GraphNode,
  GraphPart,
  GridSettings,
  NodePosition,
  OccluderPath,
  OnionSettings,
  PartDisplayState,
  Point,
  ProjectSettings,
  ReferenceDisplay,
  SelectableRef,
  SelectionMode,
  SnapSettings,
  ToolId,
} from '../model/types.ts';
import {
  DEFAULT_PROJECT_NAME,
  addEdge,
  addNode,
  addPart,
  addPose,
  assignEdgesToPart,
  assignNodesToPart,
  cloneProject,
  createDefaultReference,
  createEmptyProject,
  createOccluder,
  defaultPartId,
  deleteEdges,
  deleteNodes,
  deleteOccluder,
  deletePart,
  findEdgeBetween,
  deletePose,
  getOccluder,
  getPose,
  movePartOrder,
  movePose,
  normalizePoseTimes,
  redistributePoseTimes,
  rescalePoseTimes,
  resolvePartId,
  type DeletePartResult,
} from '../model/projectFactory.ts';
import {
  createDefaultPartDisplay,
  partDisplayOf,
  resolvePartStates,
  sortPartsByZ,
  type ResolvedPartState,
} from '../model/parts.ts';
import { MIN_BOUNDARY_NODES } from '../model/occluders.ts';
import { findPoseSegment, sortPosesByTime } from '../preview/interpolation.ts';
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
  | 'parts'
  | 'occluders'
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
  /** Original file name, shown in the inspector. Null when unknown. */
  name: string | null;
  naturalWidth: number;
  naturalHeight: number;
}

export interface EditorState {
  project: AnimationProject;
  mode: EditorMode;
  tool: ToolId;
  activePoseId: string;
  /** Part new geometry is created in. */
  activePartId: string;
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  /** Occluder shown in the inspector, or null. */
  selectedOccluderId: string | null;
  hovered: SelectableRef | null;
  /** Editor-only lock/hide/solo/x-ray, keyed by part id. Never exported. */
  partDisplay: Record<string, PartDisplayState>;
  /** Global occluder overlay toggle in Edit mode. */
  showOccluders: boolean;
  /** What the pointer is allowed to pick. */
  selectionMode: SelectionMode;
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
      activePartId: defaultPartId(resolvedProject),
      selectedNodeIds: [],
      selectedEdgeIds: [],
      selectedOccluderId: null,
      hovered: null,
      partDisplay: sanitizePartDisplay(resolvedProject, preferences?.partDisplay),
      showOccluders: preferences?.showOccluders ?? true,
      selectionMode: preferences?.selectionMode ?? 'both',
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
        name: null,
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
      const { visible, opacity, scale } = this.state.reference;
      const preferences: EditorPreferences = {
        colors: { lineColor, glowColor, backgroundColor, showPreviewNodes },
        reference: { visible, opacity, scale },
        onion: { ...this.state.onion },
        snapping: { ...this.state.snapping },
        grid: { ...this.state.grid },
        partDisplay: { ...this.state.partDisplay },
        showOccluders: this.state.showOccluders,
        selectionMode: this.state.selectionMode,
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
    // Parts and occluders travel inside the snapshot, so anything derived from
    // them has to be re-checked after an undo.
    this.state.activePartId = resolvePartId(this.state.project, this.state.activePartId);
    if (
      this.state.selectedOccluderId &&
      !getOccluder(this.state.project, this.state.selectedOccluderId)
    ) {
      this.state.selectedOccluderId = null;
    }
    this.state.partDisplay = sanitizePartDisplay(this.state.project, this.state.partDisplay);
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
   * A data edit that folds into an open transaction.
   *
   * On its own it behaves exactly like `commit`. While a transaction is open —
   * a slider being dragged, say — it mutates and emits without touching
   * history, so the whole gesture collapses into the single entry that
   * `endTransaction` pushes instead of one entry per tick.
   */
  private mutate(label: string, changes: ChangeKey[], mutator: () => void, source?: string): void {
    if (this.pendingSnapshot) {
      mutator();
      this.state.dirty = true;
      this.emit([...changes, 'project'], source);
      this.scheduleAutosave();
      return;
    }
    this.commit(label, changes, mutator, source);
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

  /**
   * `source` names the panel that drove the gesture, exactly as the per-edit
   * calls do, so the panel that owns the control does not rebuild itself the
   * moment the handle is released.
   */
  endTransaction(changes: ChangeKey[] = ['positions'], source?: string): void {
    if (!this.pendingSnapshot) return;
    this.history.push(this.pendingSnapshot, this.pendingLabel);
    this.pendingSnapshot = null;
    this.state.dirty = true;
    this.emit([...changes, 'project', 'history'], source);
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
    this.emit(HISTORY_CHANGES);
    this.scheduleAutosave();
    return true;
  }

  redo(): boolean {
    const next = this.history.redo(this.snapshot());
    if (!next) return false;
    this.restore(next);
    this.emit(HISTORY_CHANGES);
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

  /**
   * The pose the playhead sits on: the last one starting at or before `time`
   * (the first pose before the animation's opening key). This is the frame the
   * timeline highlights while the transport is scrubbed.
   */
  poseAtTime(time: number) {
    return findPoseSegment(sortPosesByTime(this.state.project.poses), time).from;
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
        undefined,
        this.state.activePartId,
      );
      this.state.selectedNodeIds = [id];
      this.state.selectedEdgeIds = [];
    });
    return id;
  }

  /**
   * Connects two nodes in the active part.
   *
   * Two nodes are only ever joined once, whatever the layer. If the connection
   * already exists on *another* part, drawing it here moves that edge to the
   * active part rather than refusing: the edge is invisible from this layer, so
   * a bare "already connected" would be unactionable. Returns null only when
   * the edge already lives in the active part, or the pair is not connectable.
   */
  addEdgeBetween(from: string, to: string): string | null {
    if (from === to) return null;
    const existing = findEdgeBetween(this.state.project, from, to);
    if (existing) {
      if (existing.partId === this.state.activePartId) return null;
      const fromName = this.partById(existing.partId)?.name ?? 'another part';
      const toName = this.partById(this.state.activePartId)?.name ?? 'this part';
      const existingId = existing.id;
      this.commit('Move edge to part', ['topology', 'parts', 'selection'], () => {
        assignEdgesToPart(this.state.project, [existingId], this.state.activePartId);
        this.state.selectedEdgeIds = [existingId];
        this.state.selectedNodeIds = [];
      });
      this.setStatus(
        `Those nodes were already connected on “${fromName}”. Moved that edge to “${toName}”.`,
        'success',
      );
      return existingId;
    }

    let id: string | null = null;
    const before = this.state.project.edges.length;
    this.commit('Add edge', ['topology', 'selection'], () => {
      id = addEdge(this.state.project, from, to, {}, this.state.activePartId);
      if (id) {
        this.state.selectedEdgeIds = [id];
        this.state.selectedNodeIds = [];
      }
    });
    if (this.state.project.edges.length === before) {
      // Rejected (a node that no longer exists): drop the useless history entry.
      this.undoSilently();
    }
    return id;
  }

  /** Removes the last history entry when an operation turned out to be a no-op. */
  private undoSilently(): void {
    const previous = this.history.undo(this.snapshot());
    if (previous) {
      this.restore(previous);
      // The rolled-back step was never visible, so it must not be redoable.
      this.history.dropRedo();
      this.emit(['project', 'history']);
    }
  }

  deleteSelection(): void {
    const selectedNodeIds = this.state.selectedNodeIds.filter((id) => this.isNodeInteractive(id));
    const selectedEdgeIds = this.state.selectedEdgeIds.filter((id) => this.isEdgeInteractive(id));
    if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0) {
      if (this.state.selectedNodeIds.length > 0 || this.state.selectedEdgeIds.length > 0) {
        this.setStatus('That selection belongs to a locked part.', 'error');
      }
      return;
    }
    // 'occluders' too: deleting a node drops it from any boundary that used it.
    this.commit('Delete selection', ['topology', 'positions', 'selection', 'occluders'], () => {
      deleteEdges(this.state.project, selectedEdgeIds);
      deleteNodes(this.state.project, selectedNodeIds);
      this.state.selectedNodeIds = [];
      this.state.selectedEdgeIds = [];
    });
  }

  updateNode(id: string, patch: Partial<Omit<GraphNode, 'id'>>, source?: string): void {
    const node = this.nodeById(id);
    if (!node) return;
    // Inspector edits obey the same lock the stage does.
    if (!this.isNodeInteractive(id)) return;
    this.mutate('Edit node', ['topology'], () => {
      const target = this.nodeById(id)!;
      Object.assign(target, patch);
    }, source);
  }

  /**
   * Applies one patch to many nodes as a single undoable step. Locked and
   * hidden nodes are skipped rather than silently edited.
   */
  updateNodes(ids: string[], patch: Partial<Omit<GraphNode, 'id'>>, source?: string): void {
    const targets = ids.filter((id) => this.nodeById(id) && this.isNodeInteractive(id));
    if (targets.length === 0) return;
    this.mutate('Edit nodes', ['topology'], () => {
      for (const id of targets) Object.assign(this.nodeById(id)!, patch);
    }, source);
  }

  updateEdge(id: string, patch: Partial<Omit<GraphEdge, 'id' | 'from' | 'to'>>, source?: string): void {
    if (!this.edgeById(id)) return;
    if (!this.isEdgeInteractive(id)) return;
    this.mutate('Edit edge', ['topology'], () => {
      Object.assign(this.edgeById(id)!, patch);
    }, source);
  }

  /**
   * Applies one patch to many edges as a single undoable step. Locked and
   * hidden edges are skipped rather than silently edited.
   */
  updateEdges(
    ids: string[],
    patch: Partial<Omit<GraphEdge, 'id' | 'from' | 'to'>>,
    source?: string,
  ): void {
    const targets = ids.filter((id) => this.edgeById(id) && this.isEdgeInteractive(id));
    if (targets.length === 0) return;
    this.mutate('Edit edges', ['topology'], () => {
      for (const id of targets) Object.assign(this.edgeById(id)!, patch);
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
      if (!this.isNodeInteractive(id)) continue;
      pose.positions[id] = this.clampStored(positions[id]!);
    }
    this.emit(['positions'], source);
  }

  /** Single-value edit from the inspector — its own undo step. */
  setNodePosition(nodeId: string, position: NodePosition, source?: string): void {
    if (!this.isNodeInteractive(nodeId)) return;
    this.commit('Move node', ['positions'], () => {
      const pose = this.activePose;
      if (pose.positions[nodeId]) pose.positions[nodeId] = this.clampStored(position);
    }, source);
  }

  /* -------------------------------- poses ----------------------------- */

  /**
   * `keepTime` leaves the playhead alone: while scrubbing, the selection has to
   * follow the handle rather than yanking it back to the pose's own start.
   */
  setActivePose(poseId: string, options: { keepTime?: boolean } = {}): void {
    if (this.state.activePoseId === poseId) return;
    this.state.activePoseId = poseId;
    const pose = getPose(this.state.project, poseId);
    if (pose && !options.keepTime) this.state.playback.time = pose.time;
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
    // Locked and hidden parts are simply not selectable.
    nodeIds = nodeIds.filter((id) => this.isNodeInteractive(id));
    edgeIds = edgeIds.filter((id) => this.isEdgeInteractive(id));
    const sameNodes =
      nodeIds.length === this.state.selectedNodeIds.length &&
      nodeIds.every((id, index) => this.state.selectedNodeIds[index] === id);
    const sameEdges =
      edgeIds.length === this.state.selectedEdgeIds.length &&
      edgeIds.every((id, index) => this.state.selectedEdgeIds[index] === id);
    // Picking in the graph — including picking nothing, which is what Escape
    // and a click on empty canvas do — always leaves the occluder inspector.
    // It outranks node/edge selection in the Inspector, so without this the
    // occluder panel is a dead end: selecting one empties the node and edge
    // lists, which made the clearing call below look like a no-op.
    const hadOccluder = this.state.selectedOccluderId !== null;
    if (sameNodes && sameEdges && !hadOccluder) return;
    this.state.selectedOccluderId = null;
    this.state.selectedNodeIds = [...nodeIds];
    this.state.selectedEdgeIds = [...edgeIds];
    this.emit(hadOccluder ? ['selection', 'occluders'] : ['selection']);
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
    const previousDuration = this.state.project.settings.duration;
    this.commit('Project settings', ['settings', 'poses'], () => {
      Object.assign(this.state.project.settings, patch);
      // A new duration stretches or squeezes the whole timeline rather than
      // clamping the tail poses onto the final instant.
      if (patch.duration !== undefined) rescalePoseTimes(this.state.project, previousDuration);
    }, source);
    this.schedulePreferencesSave();
  }

  updateReference(patch: Partial<ReferenceState>, source?: string, withHistory = false): void {
    const apply = () => {
      Object.assign(this.state.reference, patch);
      const { visible, opacity, x, y, scale } = this.state.reference;
      this.state.project.reference = { visible, opacity, x, y, scale };
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

  /**
   * The transport's play/pause button.
   *
   * Playing from a playhead already parked on the last frame would finish
   * instantly and look like a dead button, so it rewinds first — the same thing
   * every media player does at the end of a track. The raw `setPlaying` stays
   * available for callers that must not move the playhead, such as a scrub
   * resuming the playback it interrupted.
   */
  togglePlay(): void {
    if (this.state.playback.playing) {
      this.setPlaying(false);
      return;
    }
    if (this.isAtEnd) this.setPlaybackTime(0);
    this.setPlaying(true);
  }

  /**
   * Whether the playhead sits on the final frame. The epsilon covers a clock
   * that stopped a float's breadth short of the duration.
   */
  get isAtEnd(): boolean {
    const duration = Math.max(0.001, this.state.project.settings.duration);
    return this.state.playback.time >= duration - 1e-4;
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
      this.state.activePartId = defaultPartId(project);
      this.state.selectedOccluderId = null;
      this.state.partDisplay = sanitizePartDisplay(project, this.state.partDisplay);
      if (project.reference) Object.assign(this.state.reference, project.reference);
    });
  }

  /**
   * Discards everything — geometry, poses, settings and the name — for a fresh
   * untitled document. Undoable, so a misfire is recoverable.
   */
  newProject(): void {
    this.replaceProject(createEmptyProject(), 'New project');
  }

  /** Renames the document. The name drives the export filename. */
  setProjectName(name: string, source?: string): void {
    const trimmed = name.trim() || DEFAULT_PROJECT_NAME;
    if (this.state.project.name === trimmed) return;
    this.commit('Rename project', ['project'], () => {
      this.state.project.name = trimmed;
    }, source);
  }

  get isEmptyProject(): boolean {
    return this.state.project.nodes.length === 0 && this.state.project.edges.length === 0;
  }


  /* -------------------------------- parts ----------------------------- */

  /** Parts back to front, which is also the order the Parts panel lists. */
  get partsInOrder(): GraphPart[] {
    return sortPartsByZ(this.state.project.parts);
  }

  partById(partId: string): GraphPart | undefined {
    return this.state.project.parts.find((part) => part.id === partId);
  }

  /** Resolved editor display state (lock/hide/solo/x-ray) for every part. */
  get resolvedPartStates(): Map<string, ResolvedPartState> {
    return resolvePartStates(this.state.project.parts, this.state.partDisplay);
  }

  partStateOf(partId: string): ResolvedPartState {
    return (
      this.resolvedPartStates.get(partId) ?? {
        visible: true,
        interactive: true,
        locked: false,
        xray: false,
      }
    );
  }

  isNodeInteractive(nodeId: string): boolean {
    const node = this.nodeById(nodeId);
    if (!node) return false;
    return this.partStateOf(node.partId).interactive;
  }

  isEdgeInteractive(edgeId: string): boolean {
    const edge = this.edgeById(edgeId);
    if (!edge) return false;
    return this.partStateOf(edge.partId).interactive;
  }

  /** An occluder is editable only while its owner part is unlocked and visible. */
  isOccluderInteractive(occluderId: string): boolean {
    const occluder = getOccluder(this.state.project, occluderId);
    if (!occluder) return false;
    return this.partStateOf(occluder.ownerPartId).interactive;
  }

  setActivePart(partId: string): void {
    const resolved = resolvePartId(this.state.project, partId);
    if (this.state.activePartId === resolved) return;
    this.state.activePartId = resolved;
    this.emit(['parts']);
  }

  createPart(name?: string): string {
    let id = '';
    this.commit('Add part', ['parts'], () => {
      id = addPart(this.state.project, name).id;
      this.state.activePartId = id;
    });
    return id;
  }

  renamePart(partId: string, name: string, source?: string): void {
    const part = this.partById(partId);
    if (!part || part.name === name) return;
    this.commit('Rename part', ['parts'], () => {
      const target = this.partById(partId);
      if (target) target.name = name;
    }, source);
  }

  setPartRole(partId: string, role: GraphPart['role'], source?: string): void {
    const part = this.partById(partId);
    if (!part || part.role === role) return;
    this.commit('Change part role', ['parts'], () => {
      const target = this.partById(partId);
      if (target) target.role = role;
    }, source);
  }

  /** Runtime (exported) visibility. Editor hide/solo is a separate concern. */
  setPartRenderEnabled(partId: string, renderEnabled: boolean, source?: string): void {
    const part = this.partById(partId);
    if (!part || part.renderEnabled === renderEnabled) return;
    this.commit('Part render toggle', ['parts'], () => {
      const target = this.partById(partId);
      if (target) target.renderEnabled = renderEnabled;
    }, source);
  }

  movePart(partId: string, offset: number): boolean {
    let moved = false;
    this.commit('Reorder parts', ['parts'], () => {
      moved = movePartOrder(this.state.project, partId, offset);
    });
    if (!moved) this.undoSilently();
    return moved;
  }

  /**
   * Refuses to delete the last remaining part, and refuses a part with contents
   * unless the caller passes the part its geometry should move to.
   */
  removePart(partId: string, reassignTo?: string): DeletePartResult {
    let result: DeletePartResult = { ok: false, reason: 'missing' };
    this.commit('Delete part', ['parts', 'topology', 'occluders'], () => {
      result = deletePart(this.state.project, partId, reassignTo);
      if (result.ok) {
        this.state.activePartId = resolvePartId(this.state.project, this.state.activePartId);
        this.state.partDisplay = sanitizePartDisplay(this.state.project, this.state.partDisplay);
      }
    });
    if (!result.ok) this.undoSilently();
    return result;
  }

  assignSelectionToPart(partId: string, source?: string): void {
    const nodeIds = this.state.selectedNodeIds.filter((id) => this.isNodeInteractive(id));
    const edgeIds = this.state.selectedEdgeIds.filter((id) => this.isEdgeInteractive(id));
    if (nodeIds.length === 0 && edgeIds.length === 0) return;
    this.commit('Assign to part', ['topology', 'parts'], () => {
      assignNodesToPart(this.state.project, nodeIds, partId);
      assignEdgesToPart(this.state.project, edgeIds, partId);
    }, source);
  }

  setNodePart(nodeId: string, partId: string, source?: string): void {
    const node = this.nodeById(nodeId);
    if (!node || node.partId === partId) return;
    this.commit('Move node to part', ['topology', 'parts'], () => {
      assignNodesToPart(this.state.project, [nodeId], partId);
    }, source);
  }

  setEdgePart(edgeId: string, partId: string, source?: string): void {
    const edge = this.edgeById(edgeId);
    if (!edge || edge.partId === partId) return;
    this.commit('Move edge to part', ['topology', 'parts'], () => {
      assignEdgesToPart(this.state.project, [edgeId], partId);
    }, source);
  }

  /* -------------------- editor-only part display ---------------------- */

  /**
   * Lock/hide/solo/x-ray are editor state: they never enter the project, never
   * reach the Preview renderer and never create a history entry. They persist
   * through the editor-preferences store instead.
   */
  updatePartDisplay(partId: string, patch: Partial<PartDisplayState>, source?: string): void {
    const current = partDisplayOf(this.state.partDisplay, partId);
    const next = { ...current, ...patch };
    this.state.partDisplay = { ...this.state.partDisplay, [partId]: next };
    // Locking (or hiding, or soloing something else) can strand the selection.
    this.pruneSelectionAgainstLocks();
    this.emit(['parts', 'view', 'selection'], source);
    this.schedulePreferencesSave();
  }

  clearSolo(): void {
    const display: Record<string, PartDisplayState> = {};
    for (const [id, state] of Object.entries(this.state.partDisplay)) {
      display[id] = { ...state, solo: false };
    }
    this.state.partDisplay = display;
    this.pruneSelectionAgainstLocks();
    this.emit(['parts', 'view', 'selection']);
    this.schedulePreferencesSave();
  }

  /**
   * Editor-only pick filter. Switching to a single kind clears the selection of
   * the other kind, so what is highlighted always matches what is pickable.
   */
  setSelectionMode(selectionMode: SelectionMode): void {
    if (this.state.selectionMode === selectionMode) return;
    this.state.selectionMode = selectionMode;
    if (selectionMode === 'nodes') this.state.selectedEdgeIds = [];
    if (selectionMode === 'edges') this.state.selectedNodeIds = [];
    this.state.hovered = null;
    this.emit(['tool', 'selection', 'view']);
    this.schedulePreferencesSave();
  }

  get canPickNodes(): boolean {
    return this.state.selectionMode !== 'edges';
  }

  get canPickEdges(): boolean {
    return this.state.selectionMode !== 'nodes';
  }

  setShowOccluders(showOccluders: boolean): void {
    if (this.state.showOccluders === showOccluders) return;
    this.state.showOccluders = showOccluders;
    this.emit(['view', 'occluders']);
    this.schedulePreferencesSave();
  }

  /** Drops anything from the selection that has become non-interactive. */
  private pruneSelectionAgainstLocks(): void {
    const nodeIds = this.state.selectedNodeIds.filter((id) => this.isNodeInteractive(id));
    const edgeIds = this.state.selectedEdgeIds.filter((id) => this.isEdgeInteractive(id));
    if (
      nodeIds.length === this.state.selectedNodeIds.length &&
      edgeIds.length === this.state.selectedEdgeIds.length
    ) {
      return;
    }
    this.state.selectedNodeIds = nodeIds;
    this.state.selectedEdgeIds = edgeIds;
  }

  /* ------------------------------ occluders --------------------------- */

  get selectedOccluder(): OccluderPath | null {
    const id = this.state.selectedOccluderId;
    return id ? getOccluder(this.state.project, id) ?? null : null;
  }

  selectOccluder(occluderId: string | null): void {
    if (this.state.selectedOccluderId === occluderId) return;
    this.state.selectedOccluderId = occluderId;
    if (occluderId) {
      // The occluder inspector replaces the node/edge one.
      this.state.selectedNodeIds = [];
      this.state.selectedEdgeIds = [];
    }
    this.emit(['occluders', 'selection']);
  }

  /**
   * Sensible default targets for a new occluder: the far wing, which is the
   * layer body and near-wing silhouettes exist to erase. An occluder owned by
   * the far wing itself starts with no targets rather than masking itself.
   */
  suggestedOccluderTargets(ownerPartId: string): string[] {
    const owner = this.partById(ownerPartId);
    const farWing = this.state.project.parts.find((part) => part.role === 'far-wing');
    if (!farWing || owner?.role === 'far-wing') return [];
    return [farWing.id];
  }

  /**
   * Creates a closed masking polygon from existing nodes. Returns null (and
   * reports) when fewer than three distinct nodes were collected.
   */
  addOccluder(
    boundaryNodeIds: string[],
    options: { name?: string; ownerPartId?: string; targetPartIds?: string[] } = {},
  ): string | null {
    const unique = [...new Set(boundaryNodeIds)].filter((id) => this.nodeById(id));
    if (unique.length < MIN_BOUNDARY_NODES) {
      this.setStatus(`An occluder needs at least ${MIN_BOUNDARY_NODES} different nodes.`, 'error');
      return null;
    }
    let id: string | null = null;
    this.commit('Create occluder', ['occluders'], () => {
      const occluder = createOccluder(this.state.project, unique, options);
      id = occluder.id;
      this.state.selectedOccluderId = occluder.id;
      this.state.selectedNodeIds = [];
      this.state.selectedEdgeIds = [];
    });
    return id;
  }

  updateOccluder(
    occluderId: string,
    patch: Partial<Omit<OccluderPath, 'id'>>,
    source?: string,
  ): void {
    if (!getOccluder(this.state.project, occluderId)) return;
    this.commit('Edit occluder', ['occluders'], () => {
      const target = getOccluder(this.state.project, occluderId)!;
      Object.assign(target, patch);
      if (patch.ownerPartId) {
        target.ownerPartId = resolvePartId(this.state.project, patch.ownerPartId);
      }
      if (patch.targetPartIds) {
        target.targetPartIds = [
          ...new Set(
            patch.targetPartIds.filter((partId) =>
              this.state.project.parts.some((part) => part.id === partId),
            ),
          ),
        ];
      }
      if (patch.boundaryNodeIds) {
        target.boundaryNodeIds = [...new Set(patch.boundaryNodeIds)].filter((nodeId) =>
          this.nodeById(nodeId),
        );
      }
      if (patch.maskExpansion !== undefined) {
        target.maskExpansion = Math.max(0, patch.maskExpansion);
      }
    }, source);
  }

  toggleOccluderTarget(occluderId: string, partId: string): void {
    const occluder = getOccluder(this.state.project, occluderId);
    if (!occluder) return;
    const targets = occluder.targetPartIds.includes(partId)
      ? occluder.targetPartIds.filter((id) => id !== partId)
      : [...occluder.targetPartIds, partId];
    this.updateOccluder(occluderId, { targetPartIds: targets });
  }

  /** Flips winding order. Fill is even-odd either way; this is for readability. */
  reverseOccluderBoundary(occluderId: string): void {
    const occluder = getOccluder(this.state.project, occluderId);
    if (!occluder) return;
    this.updateOccluder(occluderId, { boundaryNodeIds: [...occluder.boundaryNodeIds].reverse() });
  }

  removeOccluderBoundaryNode(occluderId: string, nodeId: string): void {
    const occluder = getOccluder(this.state.project, occluderId);
    if (!occluder) return;
    this.updateOccluder(occluderId, {
      boundaryNodeIds: occluder.boundaryNodeIds.filter((id) => id !== nodeId),
    });
  }

  moveOccluderBoundaryNode(occluderId: string, nodeId: string, offset: number): boolean {
    const occluder = getOccluder(this.state.project, occluderId);
    if (!occluder) return false;
    const order = [...occluder.boundaryNodeIds];
    const index = order.indexOf(nodeId);
    const target = index + offset;
    if (index === -1 || target < 0 || target >= order.length) return false;
    const [moved] = order.splice(index, 1);
    order.splice(target, 0, moved!);
    this.updateOccluder(occluderId, { boundaryNodeIds: order });
    return true;
  }

  removeOccluder(occluderId: string): void {
    if (!getOccluder(this.state.project, occluderId)) return;
    this.commit('Delete occluder', ['occluders'], () => {
      deleteOccluder(this.state.project, occluderId);
      if (this.state.selectedOccluderId === occluderId) this.state.selectedOccluderId = null;
    });
  }

  /* ---------------------------- pose timing --------------------------- */

  /**
   * Spreads every pose evenly across the current duration. Pose order and all
   * authored positions are untouched — only the timestamps move. Returns false
   * when there is nothing to spread.
   */
  distributePoseTimes(): boolean {
    if (this.state.project.poses.length < 2) return false;
    this.commit('Distribute poses', ['poses'], () => {
      redistributePoseTimes(this.state.project);
      const active = getPose(this.state.project, this.state.activePoseId);
      if (active) this.state.playback.time = active.time;
    });
    return true;
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


/** Change keys an undo/redo touches: a snapshot can move anything in the document. */
const HISTORY_CHANGES: ChangeKey[] = [
  'project',
  'topology',
  'positions',
  'poses',
  'selection',
  'settings',
  'parts',
  'occluders',
  'history',
  'reference',
];

/**
 * Keeps editor display state aligned with the parts that actually exist:
 * unknown ids are dropped, new parts start with a clean state.
 */
function sanitizePartDisplay(
  project: AnimationProject,
  stored: Record<string, PartDisplayState> | undefined,
): Record<string, PartDisplayState> {
  const result: Record<string, PartDisplayState> = {};
  for (const part of project.parts) {
    result[part.id] = { ...createDefaultPartDisplay(), ...stored?.[part.id] };
  }
  return result;
}
