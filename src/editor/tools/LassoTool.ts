import Konva from 'konva';
import type { Point, ToolId } from '../../model/types.ts';
import type { EditorContext, PointerInfo, Tool } from '../types.ts';
import { midpoint, pointInPolygon } from '../../utils/geometry.ts';

const MIN_SEGMENT = 4;

/** Draw a freeform polygon; every node inside it becomes selected. */
export class LassoTool implements Tool {
  readonly id: ToolId = 'lasso';
  private ctx: EditorContext;
  private shape: Konva.Line;
  private points: Point[] = [];
  private drawing = false;
  private baseSelection: string[] = [];

  constructor(ctx: EditorContext) {
    this.ctx = ctx;
    this.shape = new Konva.Line({
      points: [],
      stroke: '#5aa2ff',
      strokeWidth: 1.5,
      fill: 'rgba(90, 162, 255, 0.10)',
      closed: true,
      listening: false,
      visible: false,
      strokeScaleEnabled: false,
      lineJoin: 'round',
    });
    ctx.overlay.add(this.shape);
  }

  deactivate(): void {
    this.reset();
  }

  private reset(): void {
    this.drawing = false;
    this.points = [];
    this.shape.visible(false);
    this.shape.points([]);
    this.ctx.overlay.batchDraw();
  }

  onPointerDown(info: PointerInfo): void {
    if (info.button !== 0) return;
    this.drawing = true;
    this.points = [{ ...info.screen }];
    this.baseSelection = info.shiftKey ? [...this.ctx.store.state.selectedNodeIds] : [];
    if (!info.shiftKey) this.ctx.store.clearSelection();
    this.shape.visible(true);
    this.shape.points([info.screen.x, info.screen.y]);
    this.ctx.overlay.batchDraw();
  }

  onPointerMove(info: PointerInfo): void {
    if (!this.drawing) return;
    const last = this.points[this.points.length - 1]!;
    if (Math.hypot(info.screen.x - last.x, info.screen.y - last.y) < MIN_SEGMENT) return;
    this.points.push({ ...info.screen });
    const flat: number[] = [];
    for (const point of this.points) flat.push(point.x, point.y);
    this.shape.points(flat);
    this.ctx.overlay.batchDraw();
  }

  onPointerUp(): void {
    if (!this.drawing) return;
    this.commitSelection();
    this.reset();
  }

  private commitSelection(): void {
    if (this.points.length < 3) return;
    const store = this.ctx.store;
    const positions = this.ctx.displayPositions();

    if (store.state.selectionMode === 'edges') {
      const edges = new Set<string>();
      for (const edge of store.state.project.edges) {
        const from = positions[edge.from];
        const to = positions[edge.to];
        if (!from || !to) continue;
        const centre = midpoint(this.ctx.normalizedToScreen(from), this.ctx.normalizedToScreen(to));
        // Midpoint containment: a lasso is drawn around what you can see, and
        // an edge reads as "in" when its middle is in.
        if (pointInPolygon(this.points, centre)) edges.add(edge.id);
      }
      store.setSelection([], [...edges]);
      return;
    }

    const selected = new Set(this.baseSelection);
    for (const node of store.state.project.nodes) {
      const position = positions[node.id];
      if (!position) continue;
      if (pointInPolygon(this.points, this.ctx.normalizedToScreen(position))) selected.add(node.id);
    }
    store.setSelection([...selected], []);
  }

  onEscape(): boolean {
    if (!this.drawing) return false;
    this.reset();
    return true;
  }
}
