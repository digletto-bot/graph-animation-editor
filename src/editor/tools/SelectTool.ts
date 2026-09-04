import Konva from 'konva';
import type { NodePosition, Point, ToolId } from '../../model/types.ts';
import type { EditorContext, PointerInfo, Tool } from '../types.ts';
import { rectContainsPoint, rectFromPoints, segmentIntersectsRect } from '../../utils/geometry.ts';

const DRAG_THRESHOLD = 3;

/**
 * Click to select, shift-click to toggle, drag a node to move the whole
 * selection, drag empty space for a rectangular marquee.
 */
export class SelectTool implements Tool {
  readonly id: ToolId = 'select';
  private ctx: EditorContext;
  private marquee: Konva.Rect;

  private mode: 'idle' | 'maybe-drag' | 'dragging' | 'marquee' = 'idle';
  private origin: Point = { x: 0, y: 0 };
  private originNormalized: NodePosition = { x: 0, y: 0 };
  private dragNodeId: string | null = null;
  private startPositions = new Map<string, NodePosition>();
  private baseSelection: string[] = [];
  private baseEdgeSelection: string[] = [];

  constructor(ctx: EditorContext) {
    this.ctx = ctx;
    this.marquee = new Konva.Rect({
      stroke: '#5aa2ff',
      strokeWidth: 1,
      dash: [4, 3],
      fill: 'rgba(90, 162, 255, 0.12)',
      listening: false,
      visible: false,
      strokeScaleEnabled: false,
    });
    ctx.overlay.add(this.marquee);
  }

  deactivate(): void {
    this.reset();
  }

  private reset(): void {
    this.mode = 'idle';
    this.dragNodeId = null;
    this.startPositions.clear();
    this.marquee.visible(false);
    this.ctx.showSnapIndicator(null);
    this.ctx.overlay.batchDraw();
  }

  onPointerDown(info: PointerInfo): void {
    const store = this.ctx.store;
    this.origin = { ...info.screen };
    this.originNormalized = { ...info.normalized };

    if (info.target) {
      if (info.shiftKey) {
        store.toggleSelection(info.target);
      } else {
        const alreadySelected =
          info.target.kind === 'node'
            ? store.state.selectedNodeIds.includes(info.target.id)
            : store.state.selectedEdgeIds.includes(info.target.id);
        if (!alreadySelected) {
          if (info.target.kind === 'node') store.setSelection([info.target.id], []);
          else store.setSelection([], [info.target.id]);
        }
      }

      if (info.target.kind === 'node' && store.state.selectedNodeIds.includes(info.target.id)) {
        this.mode = 'maybe-drag';
        this.dragNodeId = info.target.id;
        this.captureStartPositions();
      }
      return;
    }

    // Empty space: start a marquee. Shift keeps the existing selection.
    this.mode = 'marquee';
    this.baseSelection = info.shiftKey ? [...store.state.selectedNodeIds] : [];
    this.baseEdgeSelection = info.shiftKey ? [...store.state.selectedEdgeIds] : [];
    if (!info.shiftKey) store.clearSelection();
    this.marquee.setAttrs({
      x: info.screen.x,
      y: info.screen.y,
      width: 0,
      height: 0,
      visible: true,
    });
    this.ctx.overlay.batchDraw();
  }

  private captureStartPositions(): void {
    const positions = this.ctx.displayPositions();
    this.startPositions.clear();
    for (const id of this.ctx.store.state.selectedNodeIds) {
      const position = positions[id];
      if (position) this.startPositions.set(id, { ...position });
    }
  }

  onPointerMove(info: PointerInfo): void {
    if (this.mode === 'idle') return;

    if (this.mode === 'maybe-drag') {
      const moved = Math.hypot(info.screen.x - this.origin.x, info.screen.y - this.origin.y);
      if (moved < DRAG_THRESHOLD) return;
      this.mode = 'dragging';
      // One history entry for the whole drag.
      this.ctx.store.beginTransaction('Move nodes');
    }

    if (this.mode === 'dragging') {
      this.applyDrag(info);
      return;
    }

    if (this.mode === 'marquee') {
      const rect = rectFromPoints(this.origin, info.screen);
      this.marquee.setAttrs(rect);
      this.ctx.overlay.batchDraw();
      this.applyMarqueeSelection(rect);
    }
  }

  private applyDrag(info: PointerInfo): void {
    const dx = info.normalized.x - this.originNormalized.x;
    const dy = info.normalized.y - this.originNormalized.y;

    // Snap using the node actually under the cursor, then move the rest by the
    // same corrected delta so the selection keeps its shape.
    let correctedDx = dx;
    let correctedDy = dy;
    let indicator: Point | null = null;

    const anchorStart = this.dragNodeId ? this.startPositions.get(this.dragNodeId) : undefined;
    if (anchorStart) {
      const raw = { x: anchorStart.x + dx, y: anchorStart.y + dy };
      const snapped = this.ctx.snap(raw, [...this.startPositions.keys()], info.altKey);
      correctedDx = snapped.position.x - anchorStart.x;
      correctedDy = snapped.position.y - anchorStart.y;
      indicator = snapped.indicator;
    }
    this.ctx.showSnapIndicator(indicator);

    const next: Record<string, NodePosition> = {};
    for (const [id, start] of this.startPositions) {
      next[id] = { x: start.x + correctedDx, y: start.y + correctedDy };
    }
    this.ctx.store.setNodePositions(next);
  }

  private applyMarqueeSelection(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): void {
    const store = this.ctx.store;
    const positions = this.ctx.displayPositions();

    // In edges-only mode the box sweeps edges instead of nodes, which is the
    // only practical way to clear out a mesh of edges in bulk.
    if (store.state.selectionMode === 'edges') {
      const edges = new Set(this.baseEdgeSelection);
      for (const edge of store.state.project.edges) {
        const from = positions[edge.from];
        const to = positions[edge.to];
        if (!from || !to) continue;
        const a = this.ctx.normalizedToScreen(from);
        const b = this.ctx.normalizedToScreen(to);
        // Any overlap counts, so an edge crossing the box is caught even when
        // both of its endpoints lie outside it.
        if (segmentIntersectsRect(a, b, rect)) edges.add(edge.id);
      }
      store.setSelection([], [...edges]);
      return;
    }

    const inside = new Set(this.baseSelection);
    for (const node of store.state.project.nodes) {
      const position = positions[node.id];
      if (!position) continue;
      if (rectContainsPoint(rect, this.ctx.normalizedToScreen(position))) inside.add(node.id);
    }
    store.setSelection([...inside], []);
  }

  onPointerUp(_info: PointerInfo): void {
    if (this.mode === 'dragging') {
      this.ctx.store.endTransaction(['positions']);
    }
    this.reset();
  }

  onEscape(): boolean {
    if (this.mode === 'dragging') {
      this.ctx.store.cancelTransaction();
      this.reset();
      return true;
    }
    if (this.mode === 'marquee') {
      this.reset();
      return true;
    }
    return false;
  }
}
