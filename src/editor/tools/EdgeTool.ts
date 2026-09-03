import Konva from 'konva';
import type { ToolId } from '../../model/types.ts';
import type { EditorContext, PointerInfo, Tool } from '../types.ts';

/**
 * Click a node to start, click a second node to connect. Self-edges and
 * duplicates are rejected by the model layer and reported here.
 */
export class EdgeTool implements Tool {
  readonly id: ToolId = 'edge';
  private ctx: EditorContext;
  private preview: Konva.Line;
  private startNodeId: string | null = null;

  constructor(ctx: EditorContext) {
    this.ctx = ctx;
    this.preview = new Konva.Line({
      points: [],
      stroke: '#5aa2ff',
      strokeWidth: 1.5,
      dash: [6, 4],
      listening: false,
      visible: false,
      strokeScaleEnabled: false,
    });
    ctx.overlay.add(this.preview);
  }

  deactivate(): void {
    this.cancel();
  }

  private cancel(): void {
    this.startNodeId = null;
    this.preview.visible(false);
    this.ctx.showSnapIndicator(null);
    this.ctx.overlay.batchDraw();
  }

  onPointerDown(info: PointerInfo): void {
    if (info.button !== 0) return;
    const nodeId = info.target?.kind === 'node' ? info.target.id : this.ctx.nodeAtScreenPoint(info.screen);
    if (!nodeId) {
      this.cancel();
      return;
    }
    if (!this.startNodeId) {
      this.startNodeId = nodeId;
      this.ctx.store.setSelection([nodeId], []);
      return;
    }
    if (nodeId === this.startNodeId) {
      this.ctx.store.setStatus('An edge needs two different nodes.', 'error');
      return;
    }
    const created = this.ctx.store.addEdgeBetween(this.startNodeId, nodeId);
    if (!created) {
      this.ctx.store.setStatus('Those nodes are already connected.', 'error');
    }
    // Chain from the node just connected, which makes tracing a line fast.
    this.startNodeId = nodeId;
    this.updatePreview(info);
  }

  onPointerMove(info: PointerInfo): void {
    this.updatePreview(info);
  }

  private updatePreview(info: PointerInfo): void {
    if (!this.startNodeId) {
      this.preview.visible(false);
      this.ctx.overlay.batchDraw();
      return;
    }
    const positions = this.ctx.displayPositions();
    const start = positions[this.startNodeId];
    if (!start) {
      this.cancel();
      return;
    }
    const from = this.ctx.normalizedToScreen(start);
    this.preview.points([from.x, from.y, info.screen.x, info.screen.y]);
    this.preview.visible(true);
    this.ctx.overlay.batchDraw();
  }

  onEscape(): boolean {
    if (!this.startNodeId) return false;
    this.cancel();
    return true;
  }
}
