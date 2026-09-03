import Konva from 'konva';
import type { NodePosition, Point, ToolId } from '../../model/types.ts';
import type { EditorContext, PointerInfo, Tool } from '../types.ts';
import { MIN_BOUNDARY_NODES } from '../../model/occluders.ts';

/**
 * Closed-occluder authoring.
 *
 * Click existing nodes in order to trace a silhouette, with a live preview
 * polygon and a rubber band to the cursor. Enter or a double click closes it,
 * Escape cancels. Nothing is ever created from thin air: an occluder is only
 * ever a list of node references.
 */
export class OccluderTool implements Tool {
  readonly id: ToolId = 'occluder';
  private ctx: EditorContext;
  private polygon: Konva.Line;
  private rubberBand: Konva.Line;
  private markers: Konva.Group;
  private boundary: string[] = [];
  private lastClickAt = 0;
  private lastClickNodeId: string | null = null;
  /** Last cursor position, so the preview can be rebuilt without a new event. */
  private lastPointer: Point | null = null;

  constructor(ctx: EditorContext) {
    this.ctx = ctx;
    this.polygon = new Konva.Line({
      points: [],
      closed: true,
      stroke: '#f0a05b',
      strokeWidth: 1.6,
      fill: 'rgba(240, 160, 91, 0.12)',
      listening: false,
      visible: false,
      strokeScaleEnabled: false,
      lineJoin: 'round',
    });
    this.rubberBand = new Konva.Line({
      points: [],
      stroke: '#f0a05b',
      strokeWidth: 1.2,
      dash: [6, 4],
      listening: false,
      visible: false,
      strokeScaleEnabled: false,
    });
    this.markers = new Konva.Group({ listening: false });
    ctx.overlay.add(this.polygon, this.rubberBand, this.markers);
  }

  activate(): void {
    this.ctx.store.setStatus(
      'Occluder: click boundary nodes in order, then press Enter or double-click to close.',
      'info',
    );
  }

  deactivate(): void {
    this.cancel();
  }

  private cancel(): void {
    this.boundary = [];
    this.lastClickNodeId = null;
    this.lastPointer = null;
    this.polygon.visible(false);
    this.polygon.points([]);
    this.rubberBand.visible(false);
    this.markers.destroyChildren();
    this.ctx.overlay.batchDraw();
  }

  onPointerDown(info: PointerInfo): void {
    if (info.button !== 0) return;
    const nodeId =
      info.target?.kind === 'node' ? info.target.id : this.ctx.nodeAtScreenPoint(info.screen);
    if (!nodeId) {
      this.ctx.store.setStatus('Occluder boundaries are built from existing nodes.', 'error');
      return;
    }

    // Double click, or clicking the first node again, closes the polygon.
    const now = Date.now();
    const isDoubleClick = this.lastClickNodeId === nodeId && now - this.lastClickAt < 400;
    this.lastClickAt = now;
    this.lastClickNodeId = nodeId;

    if (isDoubleClick || (this.boundary.length >= MIN_BOUNDARY_NODES && nodeId === this.boundary[0])) {
      this.close();
      return;
    }
    if (this.boundary.includes(nodeId)) {
      this.ctx.store.setStatus('That node is already on the boundary.', 'error');
      return;
    }

    this.boundary.push(nodeId);
    this.updatePreview(info);
  }

  onPointerMove(info: PointerInfo): void {
    this.updatePreview(info);
  }

  /**
   * Camera moved. The boundary is a list of node ids, so the polygon is simply
   * re-projected through the new camera; only the rubber band needs the cursor,
   * which stays where it is on screen.
   */
  sync(): void {
    this.redraw();
  }

  /** Enter commits the polygon; the editor forwards the key. */
  commit(): boolean {
    if (this.boundary.length < MIN_BOUNDARY_NODES) return false;
    this.close();
    return true;
  }

  get pointCount(): number {
    return this.boundary.length;
  }

  private close(): void {
    if (this.boundary.length < MIN_BOUNDARY_NODES) {
      this.ctx.store.setStatus(
        `An occluder needs at least ${MIN_BOUNDARY_NODES} different nodes.`,
        'error',
      );
      return;
    }
    const store = this.ctx.store;
    // The active part owns the silhouette; the far wing is the usual target.
    const ownerPartId = store.state.activePartId;
    const targets = store.suggestedOccluderTargets(ownerPartId);
    const created = store.addOccluder(this.boundary, { ownerPartId, targetPartIds: targets });
    if (created) {
      store.setStatus(
        'Occluder created. Set its owner, targets and mask expansion in the inspector.',
        'success',
      );
    }
    this.cancel();
  }

  private updatePreview(info: PointerInfo): void {
    this.lastPointer = { ...info.screen };
    this.redraw();
  }

  private redraw(): void {
    if (this.boundary.length === 0) {
      this.polygon.visible(false);
      this.rubberBand.visible(false);
      this.markers.destroyChildren();
      this.ctx.overlay.batchDraw();
      return;
    }
    const positions = this.ctx.displayPositions();
    const screenPoints: { x: number; y: number }[] = [];
    for (const nodeId of this.boundary) {
      const position = positions[nodeId] as NodePosition | undefined;
      if (!position) continue;
      screenPoints.push(this.ctx.normalizedToScreen(position));
    }

    const flat: number[] = [];
    for (const point of screenPoints) flat.push(point.x, point.y);
    this.polygon.points(flat);
    this.polygon.visible(screenPoints.length >= 2);

    const last = screenPoints[screenPoints.length - 1];
    const pointer = this.lastPointer;
    if (last && pointer) {
      this.rubberBand.points([last.x, last.y, pointer.x, pointer.y]);
      this.rubberBand.visible(true);
    } else {
      this.rubberBand.visible(false);
    }

    this.markers.destroyChildren();
    screenPoints.forEach((point, index) => {
      this.markers.add(
        new Konva.Circle({
          x: point.x,
          y: point.y,
          radius: index === 0 ? 6 : 4,
          stroke: '#f0a05b',
          strokeWidth: 1.5,
          listening: false,
          perfectDrawEnabled: false,
        }),
      );
    });
    this.ctx.overlay.batchDraw();
  }

  onEscape(): boolean {
    if (this.boundary.length === 0) return false;
    this.cancel();
    this.ctx.store.setStatus('Occluder cancelled.', 'info');
    return true;
  }
}
