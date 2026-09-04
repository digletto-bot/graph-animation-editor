import Konva from 'konva';
import type { NodePosition, Point, SelectableRef, ToolId } from '../model/types.ts';
import type { ChangeKey, EditorStore } from '../state/EditorStore.ts';
import { CameraController } from './CameraController.ts';
import { OccluderLayer } from './OccluderLayer.ts';
import { OnionSkinLayer } from './OnionSkinLayer.ts';
import { ReferenceImageLayer } from './ReferenceImageLayer.ts';
import { TransformController } from './TransformController.ts';
import type { EditorContext, PointerInfo, SnapResult, Tool } from './types.ts';
import { SelectTool } from './tools/SelectTool.ts';
import { NodeTool } from './tools/NodeTool.ts';
import { EdgeTool } from './tools/EdgeTool.ts';
import { LassoTool } from './tools/LassoTool.ts';
import { PanTool } from './tools/PanTool.ts';
import { OccluderTool } from './tools/OccluderTool.ts';
import { ReferenceTool } from './tools/ReferenceTool.ts';
import {
  normalizedToStage,
  projectToStage,
  stageToNormalized,
} from '../utils/coordinates.ts';
import { samplePositions } from '../runtime/interpolation.ts';
import { distanceToSegment } from '../utils/geometry.ts';
import { PART_EDITOR_COLORS } from '../model/partDisplay.ts';

const NODE_RADIUS = 5;
const NODE_HIT_RADIUS = 13;
/** Edge pick radius while nodes are excluded from picking. */
const EDGE_HIT_TOLERANCE = 12;
/*
 * The editor draws every edge at one weight. Per-edge width is an output
 * property: showing it here made heavy edges swamp their neighbours while
 * tracing, and it belongs in Preview, where the finished art is judged.
 */
const EDITOR_EDGE_WIDTH = 2.4;
const COLOR_LINE = '#f0e7d6';
const COLOR_SELECTED = '#5aa2ff';
const COLOR_HOVER = '#ffffff';
/** X-ray parts are drawn in their part colour at reduced alpha, above the rest. */
const XRAY_OPACITY = 0.55;

/**
 * Edit-mode renderer. Konva shapes are a *projection* of the store — the store
 * stays authoritative, and every shape is rebuilt or re-synced from it.
 *
 * Layers, bottom to top:
 *   background  (frame, grid, reference image)  — non-listening
 *   onion       (neighbouring poses)            — non-listening
 *   graph       (edges + nodes, plus the x-ray pass) — interactive
 *   occluder    (masking polygons)              — non-listening
 *   overlay     (marquee, lasso, snap hints)    — non-listening
 *   tool        (transform box)                 — interactive
 *
 * Parts are a *style and interactivity* concern here, not a container: shapes
 * stay in the same two groups and are re-styled from the part's resolved editor
 * state, so hiding or locking a part never rebuilds the scene graph.
 */
export class KonvaEditor {
  private container: HTMLDivElement;
  private store: EditorStore;
  private stage: Konva.Stage;

  private backgroundLayer: Konva.Layer;
  private onionLayer: Konva.Layer;
  private graphLayer: Konva.Layer;
  private occluderLayer: Konva.Layer;
  private overlayLayer: Konva.Layer;
  private toolLayer: Konva.Layer;

  private frame: Konva.Rect;
  private grid: Konva.Shape;
  private snapIndicator: Konva.Circle;
  private edgeGroup: Konva.Group;
  private nodeGroup: Konva.Group;
  /** Drawn above the ordinary graph so an x-rayed part is always reachable. */
  private xrayEdgeGroup: Konva.Group;
  private xrayNodeGroup: Konva.Group;

  private edgeShapes = new Map<string, Konva.Line>();
  private nodeShapes = new Map<string, Konva.Circle>();

  camera: CameraController;
  reference: ReferenceImageLayer;
  private onion: OnionSkinLayer;
  private occluders: OccluderLayer;
  private transform: TransformController;

  private tools = new Map<ToolId, Tool>();
  private activeTool: Tool;
  private ctx: EditorContext;

  private resizeObserver: ResizeObserver;
  private unsubscribe: () => void;
  private spaceDown = false;
  private pointerDownActive = false;
  private temporaryPan = false;
  private cachedPositions: Record<string, NodePosition> = {};

  constructor(container: HTMLDivElement, store: EditorStore) {
    this.container = container;
    this.store = store;

    const size = this.measure();
    this.stage = new Konva.Stage({ container, width: size.width, height: size.height });

    this.backgroundLayer = new Konva.Layer({ listening: false });
    this.onionLayer = new Konva.Layer({ listening: false });
    this.graphLayer = new Konva.Layer();
    this.occluderLayer = new Konva.Layer({ listening: false });
    this.overlayLayer = new Konva.Layer({ listening: false });
    this.toolLayer = new Konva.Layer();
    this.stage.add(
      this.backgroundLayer,
      this.onionLayer,
      this.graphLayer,
      this.occluderLayer,
      this.overlayLayer,
      this.toolLayer,
    );

    this.frame = new Konva.Rect({
      stroke: 'rgba(240, 231, 214, 0.22)',
      strokeWidth: 1,
      fill: 'rgba(255, 255, 255, 0.015)',
      strokeScaleEnabled: false,
      listening: false,
    });
    this.grid = new Konva.Shape({
      listening: false,
      sceneFunc: (context, shape) => this.drawGrid(context, shape),
    });
    this.backgroundLayer.add(this.frame, this.grid);

    this.snapIndicator = new Konva.Circle({
      radius: 9,
      stroke: '#7cf0c4',
      strokeWidth: 1.5,
      listening: false,
      visible: false,
      strokeScaleEnabled: false,
    });
    this.overlayLayer.add(this.snapIndicator);

    this.edgeGroup = new Konva.Group();
    this.nodeGroup = new Konva.Group();
    this.xrayEdgeGroup = new Konva.Group();
    this.xrayNodeGroup = new Konva.Group();
    this.graphLayer.add(this.edgeGroup, this.nodeGroup, this.xrayEdgeGroup, this.xrayNodeGroup);

    this.ctx = this.createContext();
    this.camera = new CameraController(store);
    this.reference = new ReferenceImageLayer(store, this.backgroundLayer);
    this.onion = new OnionSkinLayer(store, this.onionLayer);
    this.occluders = new OccluderLayer(store, this.occluderLayer, () => this.displayPositions());
    this.transform = new TransformController(this.ctx, this.toolLayer);

    this.tools.set('select', new SelectTool(this.ctx));
    this.tools.set('node', new NodeTool(this.ctx));
    this.tools.set('edge', new EdgeTool(this.ctx));
    this.tools.set('lasso', new LassoTool(this.ctx));
    this.tools.set('pan', new PanTool(this.ctx, this.camera));
    this.tools.set('occluder', new OccluderTool(this.ctx));
    this.tools.set('reference', new ReferenceTool(this.ctx));
    this.activeTool = this.tools.get(store.state.tool)!;
    this.activeTool.activate?.();

    this.attachInput();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);

    this.unsubscribe = store.subscribe((changes) => this.onStoreChange(changes));

    this.camera.fit(this.measure());
    this.rebuild();
  }

  /* ------------------------------ context ----------------------------- */

  private createContext(): EditorContext {
    return {
      store: this.store,
      stage: this.stage,
      overlay: this.overlayLayer,
      displayPositions: () => this.displayPositions(),
      screenToNormalized: (point) =>
        stageToNormalized(point, this.store.state.project.settings, this.store.state.camera),
      normalizedToScreen: (point) =>
        normalizedToStage(point, this.store.state.project.settings, this.store.state.camera),
      snap: (position, exclude, bypass) => this.snap(position, exclude, bypass),
      showSnapIndicator: (point) => this.showSnapIndicator(point),
      syncPositions: () => this.syncPositions(),
      refreshOverlay: () => this.overlayLayer.batchDraw(),
      nodeAtScreenPoint: (point) => this.nodeAtScreenPoint(point),
      setCursor: (cursor) => {
        this.container.style.cursor = cursor;
      },
    };
  }

  /**
   * Positions actually drawn: the active pose normally, or the interpolated
   * frame while the timeline is playing or being scrubbed.
   */
  private displayPositions(): Record<string, NodePosition> {
    if (this.store.isPreviewingTimeline) {
      this.cachedPositions = samplePositions(this.store.state.project, this.store.state.playback.time);
      return this.cachedPositions;
    }
    return this.store.activePose.positions;
  }

  /* ------------------------------- layout ----------------------------- */

  private measure(): { width: number; height: number } {
    const rect = this.container.getBoundingClientRect();
    return { width: Math.max(1, Math.floor(rect.width)), height: Math.max(1, Math.floor(rect.height)) };
  }

  resize(): void {
    const size = this.measure();
    if (size.width === this.stage.width() && size.height === this.stage.height()) return;
    this.stage.size(size);
    this.syncPositions();
  }

  fitProject(): void {
    this.camera.fit(this.measure());
  }

  resetView(): void {
    this.camera.reset(this.measure());
  }

  zoomBy(factor: number): void {
    this.camera.zoomBy(factor, this.measure());
  }

  setVisible(visible: boolean): void {
    this.container.style.display = visible ? '' : 'none';
    if (visible) {
      this.resize();
      this.syncPositions();
    }
  }

  exportDataUrl(): string {
    return this.stage.toDataURL({ mimeType: 'image/png', pixelRatio: 2 });
  }

  /* ------------------------------ rendering --------------------------- */

  /** Full rebuild — only for topology changes, never per pointer move. */
  rebuild(): void {
    const project = this.store.state.project;

    const liveEdgeIds = new Set(project.edges.map((edge) => edge.id));
    for (const [id, shape] of this.edgeShapes) {
      if (!liveEdgeIds.has(id)) {
        shape.destroy();
        this.edgeShapes.delete(id);
      }
    }
    const liveNodeIds = new Set(project.nodes.map((node) => node.id));
    for (const [id, shape] of this.nodeShapes) {
      if (!liveNodeIds.has(id)) {
        shape.destroy();
        this.nodeShapes.delete(id);
      }
    }

    for (const edge of project.edges) {
      if (this.edgeShapes.has(edge.id)) continue;
      const line = new Konva.Line({
        points: [0, 0, 0, 0],
        stroke: COLOR_LINE,
        lineCap: 'round',
        hitStrokeWidth: 14,
        perfectDrawEnabled: false,
        shadowForStrokeEnabled: false,
      });
      const ref: SelectableRef = { kind: 'edge', id: edge.id };
      line.setAttr('ref', ref);
      this.edgeShapes.set(edge.id, line);
      this.edgeGroup.add(line);
    }

    for (const node of project.nodes) {
      if (this.nodeShapes.has(node.id)) continue;
      const circle = new Konva.Circle({
        radius: NODE_RADIUS,
        fill: COLOR_LINE,
        stroke: '#0b0d12',
        strokeWidth: 1,
        hitStrokeWidth: NODE_HIT_RADIUS,
        perfectDrawEnabled: false,
        shadowForStrokeEnabled: false,
      });
      const ref: SelectableRef = { kind: 'node', id: node.id };
      circle.setAttr('ref', ref);
      this.nodeShapes.set(node.id, circle);
      this.nodeGroup.add(circle);
    }

    this.syncPositions();
  }

  /** Cheap per-frame update: coordinates + styles for existing shapes. */
  syncPositions(): void {
    const state = this.store.state;
    const { settings, edges, nodes } = state.project;
    const camera = state.camera;
    const positions = this.displayPositions();

    const origin = projectToStage({ x: 0, y: 0 }, camera);
    this.frame.setAttrs({
      x: origin.x,
      y: origin.y,
      width: settings.width * camera.scale,
      height: settings.height * camera.scale,
    });
    this.grid.visible(state.grid.visible);

    const selectedNodes = new Set(state.selectedNodeIds);
    const selectedEdges = new Set(state.selectedEdgeIds);
    const hovered = state.hovered;
    const interactive = state.mode === 'edit' && !this.store.isPreviewingTimeline;
    const partStates = this.store.resolvedPartStates;

    for (const edge of edges) {
      const shape = this.edgeShapes.get(edge.id);
      if (!shape) continue;
      const from = positions[edge.from];
      const to = positions[edge.to];
      const part = partStates.get(edge.partId);
      if (!from || !to || (part && !part.visible)) {
        shape.visible(false);
        shape.listening(false);
        continue;
      }
      const a = normalizedToStage(from, settings, camera);
      const b = normalizedToStage(to, settings, camera);
      const selected = selectedEdges.has(edge.id);
      const isHovered = hovered?.kind === 'edge' && hovered.id === edge.id;
      const xray = part?.xray ?? false;
      shape.visible(true);
      shape.points([a.x, a.y, b.x, b.y]);
      shape.stroke(
        selected
          ? COLOR_SELECTED
          : isHovered
            ? COLOR_HOVER
            : xray
              ? PART_EDITOR_COLORS[this.roleOf(edge.partId)]
              : COLOR_LINE,
      );
      shape.strokeWidth(Math.max(1, EDITOR_EDGE_WIDTH * camera.scale) * (selected ? 1.6 : 1));
      shape.opacity(
        xray ? XRAY_OPACITY : (0.55 + Math.min(1, edge.brightness) * 0.35) * (part?.locked ? 0.5 : 1),
      );
      shape.listening(interactive && (part?.interactive ?? true));
      this.assignGroup(shape, xray ? this.xrayEdgeGroup : this.edgeGroup);
    }

    for (const node of nodes) {
      const shape = this.nodeShapes.get(node.id);
      if (!shape) continue;
      const position = positions[node.id];
      const part = partStates.get(node.partId);
      if (!position || (part && !part.visible)) {
        shape.visible(false);
        shape.listening(false);
        continue;
      }
      const point = normalizedToStage(position, settings, camera);
      const selected = selectedNodes.has(node.id);
      const isHovered = hovered?.kind === 'node' && hovered.id === node.id;
      const xray = part?.xray ?? false;
      shape.visible(true);
      shape.position(point);
      shape.radius(selected ? NODE_RADIUS + 1.5 : NODE_RADIUS);
      shape.fill(
        selected
          ? COLOR_SELECTED
          : isHovered
            ? COLOR_HOVER
            : xray
              ? PART_EDITOR_COLORS[this.roleOf(node.partId)]
              : COLOR_LINE,
      );
      shape.opacity(part?.locked ? 0.5 : 1);
      shape.listening(interactive && (part?.interactive ?? true));
      this.assignGroup(shape, xray ? this.xrayNodeGroup : this.nodeGroup);
    }

    this.graphLayer.batchDraw();
    this.backgroundLayer.batchDraw();
    this.reference.sync();
    this.onion.sync();
    this.occluders.sync();
    this.transform.sync();
    // Tool previews live in screen space, so they need the same catch-up.
    this.activeTool.sync?.();
  }

  private roleOf(partId: string): keyof typeof PART_EDITOR_COLORS {
    return this.store.partById(partId)?.role ?? 'other';
  }

  /**
   * Moves a shape between the normal and x-ray groups only when it actually
   * changed group, so a pointer move never reparents the whole graph.
   */
  private assignGroup(shape: Konva.Shape, group: Konva.Group): void {
    if (shape.getParent() !== group) shape.moveTo(group);
  }

  private drawGrid(context: Konva.Context, shape: Konva.Shape): void {
    const state = this.store.state;
    if (!state.grid.visible) return;
    const { settings } = state.project;
    const camera = state.camera;
    const step = Math.max(4, state.snapping.gridSize) * camera.scale;
    if (step < 6) return;
    const origin = projectToStage({ x: 0, y: 0 }, camera);
    const width = settings.width * camera.scale;
    const height = settings.height * camera.scale;

    context.beginPath();
    for (let x = 0; x <= width + 0.5; x += step) {
      context.moveTo(origin.x + x, origin.y);
      context.lineTo(origin.x + x, origin.y + height);
    }
    for (let y = 0; y <= height + 0.5; y += step) {
      context.moveTo(origin.x, origin.y + y);
      context.lineTo(origin.x + width, origin.y + y);
    }
    context.setAttr('strokeStyle', 'rgba(240, 231, 214, 0.08)');
    context.setAttr('lineWidth', 1);
    context.stroke();
    context.fillStrokeShape(shape);
  }

  /* ------------------------------- snapping --------------------------- */

  private snap(position: NodePosition, excludeNodeIds: string[], bypass: boolean): SnapResult {
    const state = this.store.state;
    const snapping = state.snapping;
    if (bypass || !snapping.enabled) {
      return { position, indicator: null, targetNodeId: null };
    }
    const { settings } = state.project;
    const camera = state.camera;
    let result: NodePosition = { ...position };
    let indicator: Point | null = null;
    let targetNodeId: string | null = null;

    if (snapping.toGrid) {
      const step = Math.max(1, snapping.gridSize);
      const projectX = Math.round((position.x * settings.width) / step) * step;
      const projectY = Math.round((position.y * settings.height) / step) * step;
      result = { x: projectX / settings.width, y: projectY / settings.height };
    }

    if (snapping.toNodes) {
      const exclude = new Set(excludeNodeIds);
      const positions = this.displayPositions();
      const pointer = normalizedToStage(position, settings, camera);
      let best = snapping.threshold;
      for (const node of state.project.nodes) {
        if (exclude.has(node.id)) continue;
        const other = positions[node.id];
        if (!other) continue;
        const screen = normalizedToStage(other, settings, camera);
        const distance = Math.hypot(screen.x - pointer.x, screen.y - pointer.y);
        if (distance < best) {
          best = distance;
          result = { ...other };
          indicator = screen;
          targetNodeId = node.id;
        }
      }
    }

    return { position: result, indicator, targetNodeId };
  }

  private showSnapIndicator(point: Point | null): void {
    if (!point) {
      if (this.snapIndicator.visible()) {
        this.snapIndicator.visible(false);
        this.overlayLayer.batchDraw();
      }
      return;
    }
    this.snapIndicator.position(point);
    this.snapIndicator.visible(true);
    this.overlayLayer.batchDraw();
  }

  /* -------------------------------- input ----------------------------- */

  private attachInput(): void {
    this.container.addEventListener('wheel', this.handleWheel, { passive: false });
    this.container.addEventListener('pointerdown', this.handlePointerDown);
    this.container.addEventListener('pointermove', this.handleHoverMove);
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    this.container.addEventListener('contextmenu', this.handleContextMenu);
  }

  private handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.camera.zoomAt(this.pointerFromEvent(event), event.deltaY);
  };

  private pointerFromEvent(event: MouseEvent | PointerEvent): Point {
    const rect = this.container.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private buildPointerInfo(event: PointerEvent): PointerInfo {
    const screen = this.pointerFromEvent(event);
    return {
      screen,
      normalized: stageToNormalized(screen, this.store.state.project.settings, this.store.state.camera),
      target: this.resolveTarget(screen),
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      button: event.button,
    };
  }

  /** Returns the selectable under the pointer, ignoring transform handles. */
  private hitTest(point: Point): SelectableRef | null {
    const shape = this.stage.getIntersection(point);
    if (!shape) return null;
    const ref = shape.getAttr('ref') as SelectableRef | undefined;
    return ref ?? null;
  }

  /**
   * Picking, with a geometric fallback.
   *
   * Konva's hit graph is the fast path, but it is pixel-based: thin strokes and
   * small circles get unreliable at low zoom, which is exactly when the user
   * most needs to grab things. Falling back to a distance test against the
   * known geometry gives a hit area that is constant in screen pixels at any
   * zoom, and keeps picking independent of hit-canvas rendering quirks.
   */
  private resolveTarget(point: Point): SelectableRef | null {
    const store = this.store;
    const direct = this.hitTest(point);
    if (direct && this.isRefInteractive(direct) && this.isKindPickable(direct.kind)) return direct;

    if (store.canPickNodes) {
      const nodeId = this.nearestNodeId(point, NODE_HIT_RADIUS);
      if (nodeId) return { kind: 'node', id: nodeId };
    }
    if (store.canPickEdges) {
      // With nodes out of the way an edge can afford a more forgiving reach,
      // which is what makes an edge buried under a node cluster grabbable.
      const edgeId = this.nearestEdgeId(point, store.canPickNodes ? 8 : EDGE_HIT_TOLERANCE);
      if (edgeId) return { kind: 'edge', id: edgeId };
    }
    return null;
  }

  private isKindPickable(kind: SelectableRef['kind']): boolean {
    return kind === 'node' ? this.store.canPickNodes : this.store.canPickEdges;
  }

  private isRefInteractive(ref: SelectableRef): boolean {
    return ref.kind === 'node'
      ? this.store.isNodeInteractive(ref.id)
      : this.store.isEdgeInteractive(ref.id);
  }

  private nearestNodeId(point: Point, tolerance: number): string | null {
    const { settings } = this.store.state.project;
    const camera = this.store.state.camera;
    const positions = this.displayPositions();
    const partStates = this.store.resolvedPartStates;
    let best = tolerance;
    let bestId: string | null = null;
    for (const node of this.store.state.project.nodes) {
      const position = positions[node.id];
      if (!position) continue;
      // Hidden and locked parts are not pickable, geometric fallback included.
      if (!(partStates.get(node.partId)?.interactive ?? true)) continue;
      const screen = normalizedToStage(position, settings, camera);
      const gap = Math.hypot(screen.x - point.x, screen.y - point.y);
      if (gap < best) {
        best = gap;
        bestId = node.id;
      }
    }
    return bestId;
  }

  private nearestEdgeId(point: Point, tolerance: number): string | null {
    const { settings } = this.store.state.project;
    const camera = this.store.state.camera;
    const positions = this.displayPositions();
    const partStates = this.store.resolvedPartStates;
    let best = tolerance;
    let bestId: string | null = null;
    for (const edge of this.store.state.project.edges) {
      const from = positions[edge.from];
      const to = positions[edge.to];
      if (!from || !to) continue;
      if (!(partStates.get(edge.partId)?.interactive ?? true)) continue;
      const gap = distanceToSegment(
        point,
        normalizedToStage(from, settings, camera),
        normalizedToStage(to, settings, camera),
      );
      if (gap < best) {
        best = gap;
        bestId = edge.id;
      }
    }
    return bestId;
  }

  /** True when the pointer is over the transform box or its anchors. */
  private isOverToolLayer(point: Point): boolean {
    const shape = this.stage.getIntersection(point);
    if (!shape) return false;
    return shape.getLayer() === this.toolLayer;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (this.store.state.mode !== 'edit') return;
    const point = this.pointerFromEvent(event);

    // Middle-mouse or Space temporarily pans from any tool.
    if (event.button === 1 || (this.spaceDown && event.button === 0)) {
      event.preventDefault();
      this.temporaryPan = true;
      this.camera.beginPan(point);
      this.container.style.cursor = 'grabbing';
      return;
    }
    if (event.button !== 0) return;
    if (this.isOverToolLayer(point)) return; // Konva.Transformer handles it.
    if (this.store.isPreviewingTimeline) return; // Read-only while playing.

    this.pointerDownActive = true;
    this.container.setPointerCapture?.(event.pointerId);
    this.activeTool.onPointerDown?.(this.buildPointerInfo(event));
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.store.state.mode !== 'edit') return;
    if (this.temporaryPan) {
      this.camera.movePan(this.pointerFromEvent(event));
      return;
    }
    if (!this.pointerDownActive) return;
    this.activeTool.onPointerMove?.(this.buildPointerInfo(event));
  };

  /** Hover feedback + tools that preview before the first click. */
  private handleHoverMove = (event: PointerEvent): void => {
    if (this.store.state.mode !== 'edit') return;
    if (this.temporaryPan || this.pointerDownActive) return;
    const info = this.buildPointerInfo(event);
    this.store.setHovered(info.target);
    if (this.activeTool.id === 'edge' || this.activeTool.id === 'node') {
      this.activeTool.onPointerMove?.(info);
    }
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (this.temporaryPan) {
      this.temporaryPan = false;
      this.camera.endPan();
      this.container.style.cursor = this.spaceDown ? 'grab' : 'default';
      return;
    }
    if (!this.pointerDownActive) return;
    this.pointerDownActive = false;
    this.activeTool.onPointerUp?.(this.buildPointerInfo(event));
  };

  setSpaceDown(down: boolean): void {
    if (this.spaceDown === down) return;
    this.spaceDown = down;
    if (!this.pointerDownActive && !this.temporaryPan) {
      this.container.style.cursor = down ? 'grab' : this.activeTool.id === 'pan' ? 'grab' : 'default';
    }
  }

  /** Escape: let the active tool or the transform box cancel first. */
  handleEscape(): void {
    if (this.transform.cancel()) return;
    if (this.activeTool.onEscape?.()) return;
    this.store.clearSelection();
  }

  /**
   * Node lookup for the tools that only ever work with nodes (edge drawing,
   * occluder tracing). Deliberately ignores the selection mode: an edge-only
   * pick filter must not stop the Edge tool from finding its endpoints.
   */
  nodeAtScreenPoint(point: Point): string | null {
    const hit = this.hitTest(point);
    if (hit?.kind === 'node' && this.store.isNodeInteractive(hit.id)) return hit.id;
    return this.nearestNodeId(point, NODE_HIT_RADIUS);
  }

  /** Enter closes an in-progress occluder. Returns true when it was consumed. */
  commitActiveTool(): boolean {
    const tool = this.activeTool;
    return tool instanceof OccluderTool ? tool.commit() : false;
  }

  /* ------------------------------- wiring ----------------------------- */

  private onStoreChange(changes: Set<ChangeKey>): void {
    if (changes.has('tool')) this.switchTool(this.store.state.tool);
    if (changes.has('topology')) {
      this.rebuild();
      return;
    }
    // The stage is hidden in Preview mode; re-syncing it every animation frame
    // would be pure waste. The mode change itself triggers a catch-up sync.
    if (this.store.state.mode !== 'edit' && !changes.has('mode')) return;
    if (
      changes.has('positions') ||
      changes.has('camera') ||
      changes.has('poses') ||
      changes.has('settings') ||
      changes.has('selection') ||
      changes.has('view') ||
      changes.has('reference') ||
      changes.has('playback') ||
      changes.has('parts') ||
      changes.has('occluders') ||
      changes.has('mode')
    ) {
      this.syncPositions();
    }
  }

  private switchTool(toolId: ToolId): void {
    const next = this.tools.get(toolId);
    if (!next || next === this.activeTool) return;
    this.activeTool.deactivate?.();
    this.activeTool = next;
    this.activeTool.activate?.();
    this.container.style.cursor =
      toolId === 'pan' ? 'grab' : toolId === 'select' ? 'default' : 'crosshair';
    this.occluders.sync();
    this.transform.sync();
  }

  destroy(): void {
    this.unsubscribe();
    this.resizeObserver.disconnect();
    this.container.removeEventListener('wheel', this.handleWheel);
    this.container.removeEventListener('pointerdown', this.handlePointerDown);
    this.container.removeEventListener('pointermove', this.handleHoverMove);
    this.container.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    this.transform.destroy();
    this.reference.destroy();
    this.stage.destroy();
  }
}
