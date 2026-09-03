import type { ToolId } from '../../model/types.ts';
import type { EditorContext, PointerInfo, Tool } from '../types.ts';
import { isInsideNormalizedBounds } from '../../utils/coordinates.ts';

/** Click empty artwork space to add a node. Alt-click bypasses snapping. */
export class NodeTool implements Tool {
  readonly id: ToolId = 'node';
  private ctx: EditorContext;

  constructor(ctx: EditorContext) {
    this.ctx = ctx;
  }

  deactivate(): void {
    this.ctx.showSnapIndicator(null);
  }

  onPointerMove(info: PointerInfo): void {
    const snapped = this.ctx.snap(info.normalized, [], info.altKey);
    this.ctx.showSnapIndicator(snapped.indicator);
  }

  onPointerDown(info: PointerInfo): void {
    if (info.button !== 0) return;
    // Clicking an existing node just selects it rather than stacking a new one.
    if (info.target?.kind === 'node') {
      this.ctx.store.setSelection([info.target.id], []);
      return;
    }
    const snapped = this.ctx.snap(info.normalized, [], info.altKey);
    if (!isInsideNormalizedBounds(snapped.position)) {
      this.ctx.store.setStatus('Nodes must be placed inside the artwork area.', 'error');
      return;
    }
    this.ctx.store.addNodeAt(snapped.position);
  }

  onPointerUp(): void {
    this.ctx.showSnapIndicator(null);
  }
}
