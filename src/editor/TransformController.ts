import Konva from 'konva';
import type { NodePosition, Point } from '../model/types.ts';
import type { EditorContext } from './types.ts';

const PADDING = 14;
const MIN_SIZE = 24;

/**
 * Multi-node transform box.
 *
 * A single throw-away proxy rectangle carries the Konva.Transformer. Node
 * positions are recomputed from the proxy's absolute transform on every frame
 * of the gesture and written straight back into the active pose as normalized
 * coordinates. Nothing is ever parented under a transformed group, so there is
 * no residual transform left in the data model when the gesture ends.
 */
export class TransformController {
  private ctx: EditorContext;
  private layer: Konva.Layer;
  private proxy: Konva.Rect;
  private transformer: Konva.Transformer;

  private active = false;
  /** Node id -> offset inside the proxy's untransformed local space. */
  private localOffsets = new Map<string, Point>();

  constructor(ctx: EditorContext, layer: Konva.Layer) {
    this.ctx = ctx;
    this.layer = layer;

    this.proxy = new Konva.Rect({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      fill: 'rgba(90, 162, 255, 0.05)',
      stroke: 'rgba(90, 162, 255, 0.55)',
      strokeWidth: 1,
      strokeScaleEnabled: false,
      draggable: true,
      visible: false,
    });

    this.transformer = new Konva.Transformer({
      nodes: [],
      rotateEnabled: true,
      // Corner anchors scale freely; hold Shift for a uniform scale.
      keepRatio: false,
      shiftBehavior: 'default',
      ignoreStroke: true,
      padding: 0,
      anchorSize: 8,
      anchorStroke: '#5aa2ff',
      anchorFill: '#0e1218',
      anchorCornerRadius: 2,
      borderStroke: '#5aa2ff',
      borderDash: [4, 3],
      rotateAnchorOffset: 24,
      visible: false,
    });

    layer.add(this.proxy);
    layer.add(this.transformer);

    this.proxy.on('dragstart', () => this.begin());
    this.proxy.on('dragmove', () => this.apply());
    this.proxy.on('dragend', () => this.end());
    this.transformer.on('transformstart', () => this.begin());
    this.transformer.on('transform', () => this.apply());
    this.transformer.on('transformend', () => this.end());
  }

  get isTransforming(): boolean {
    return this.active;
  }

  /** Re-fit the box to the current selection. Ignored during a live gesture. */
  sync(): void {
    if (this.active) return;
    const store = this.ctx.store;
    const selected = store.state.selectedNodeIds;
    const usable =
      selected.length >= 2 && store.state.tool === 'select' && !store.isPreviewingTimeline;

    if (!usable) {
      this.hide();
      return;
    }

    const positions = this.ctx.displayPositions();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (const id of selected) {
      const position = positions[id];
      if (!position) continue;
      const screen = this.ctx.normalizedToScreen(position);
      minX = Math.min(minX, screen.x);
      minY = Math.min(minY, screen.y);
      maxX = Math.max(maxX, screen.x);
      maxY = Math.max(maxY, screen.y);
      count += 1;
    }
    if (count < 2) {
      this.hide();
      return;
    }

    const width = Math.max(MIN_SIZE, maxX - minX + PADDING * 2);
    const height = Math.max(MIN_SIZE, maxY - minY + PADDING * 2);
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;

    this.proxy.setAttrs({
      x: centreX - width / 2,
      y: centreY - height / 2,
      width,
      height,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      visible: true,
    });
    this.transformer.nodes([this.proxy]);
    this.transformer.visible(true);
    this.layer.batchDraw();
  }

  private hide(): void {
    if (!this.proxy.visible() && !this.transformer.visible()) return;
    this.transformer.nodes([]);
    this.transformer.visible(false);
    this.proxy.visible(false);
    this.layer.batchDraw();
  }

  /** Capture each node's position inside the proxy's local space. */
  private begin(): void {
    this.active = true;
    this.ctx.store.beginTransaction('Transform selection');
    const positions = this.ctx.displayPositions();
    const originX = this.proxy.x();
    const originY = this.proxy.y();
    this.localOffsets.clear();
    for (const id of this.ctx.store.state.selectedNodeIds) {
      const position = positions[id];
      if (!position) continue;
      const screen = this.ctx.normalizedToScreen(position);
      this.localOffsets.set(id, { x: screen.x - originX, y: screen.y - originY });
    }
  }

  /**
   * Map every captured offset through the proxy's current absolute transform.
   * This handles translation, rotation and both scale modes uniformly.
   */
  private apply(): void {
    if (!this.active) return;
    const matrix = this.proxy.getAbsoluteTransform();
    const next: Record<string, NodePosition> = {};
    for (const [id, offset] of this.localOffsets) {
      const screen = matrix.point(offset);
      next[id] = this.ctx.screenToNormalized(screen);
    }
    this.ctx.store.setNodePositions(next, 'transform');
  }

  private end(): void {
    if (!this.active) return;
    this.apply();
    this.active = false;
    this.localOffsets.clear();
    // Collapse the temporary transform: the data is already committed as
    // normalized positions, so the proxy goes back to identity and re-fits.
    this.proxy.scaleX(1);
    this.proxy.scaleY(1);
    this.proxy.rotation(0);
    this.ctx.store.endTransaction(['positions']);
    this.sync();
  }

  /** Abort a gesture in progress (Escape). */
  cancel(): boolean {
    if (!this.active) return false;
    this.active = false;
    this.localOffsets.clear();
    this.ctx.store.cancelTransaction();
    this.proxy.scaleX(1);
    this.proxy.scaleY(1);
    this.proxy.rotation(0);
    this.sync();
    return true;
  }

  destroy(): void {
    this.transformer.destroy();
    this.proxy.destroy();
  }
}
