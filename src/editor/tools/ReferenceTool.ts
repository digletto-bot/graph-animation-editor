import type { Point, ToolId } from '../../model/types.ts';
import type { EditorContext, PointerInfo, Tool } from '../types.ts';

/**
 * Drag the reference photo into place.
 *
 * The image deliberately stays `listening: false` on a non-listening layer and
 * is never a Konva drag target. Making it one would put a second interpretation
 * on every pointerdown over it — drag the photo, or start a marquee? — which is
 * the same conflict the transform box needs a special case to avoid. A tool
 * instead means the intent is explicit: while this is active the photo moves
 * and nothing else does, and the pointer pipeline needs no exceptions at all.
 *
 * The whole canvas is the drag surface, not just the image, so a photo dragged
 * off screen can always be recovered.
 */
export class ReferenceTool implements Tool {
  readonly id: ToolId = 'reference';
  private ctx: EditorContext;
  /** Pointer position and image origin at the start of the current drag. */
  private origin: { pointer: Point; x: number; y: number } | null = null;

  constructor(ctx: EditorContext) {
    this.ctx = ctx;
  }

  activate(): void {
    const store = this.ctx.store;
    this.ctx.setCursor(store.state.reference.src ? 'move' : 'default');
    store.setStatus(
      store.state.reference.src
        ? 'Reference: drag anywhere to move the image. Scale and opacity are in the inspector.'
        : 'No reference image loaded. Upload one in the inspector first.',
      store.state.reference.src ? 'info' : 'error',
    );
  }

  deactivate(): void {
    this.cancelDrag();
    this.ctx.setCursor('default');
  }

  onPointerDown(info: PointerInfo): void {
    if (info.button !== 0) return;
    const reference = this.ctx.store.state.reference;
    if (!reference.src) {
      this.ctx.store.setStatus('No reference image loaded.', 'error');
      return;
    }
    this.origin = { pointer: { ...info.screen }, x: reference.x, y: reference.y };
    // One history entry for the whole drag, like every other gesture.
    this.ctx.store.beginTransaction('Move reference');
    this.ctx.setCursor('grabbing');
  }

  onPointerMove(info: PointerInfo): void {
    const origin = this.origin;
    if (!origin) return;
    // The stored offset is in project pixels, so undo the camera zoom.
    const scale = this.ctx.store.state.camera.scale || 1;
    this.ctx.store.updateReference({
      x: origin.x + (info.screen.x - origin.pointer.x) / scale,
      y: origin.y + (info.screen.y - origin.pointer.y) / scale,
    });
  }

  onPointerUp(): void {
    if (!this.origin) return;
    this.origin = null;
    this.ctx.store.endTransaction(['reference']);
    this.ctx.setCursor('move');
  }

  onEscape(): boolean {
    if (!this.origin) return false;
    this.cancelDrag();
    this.ctx.store.setStatus('Reference move cancelled.', 'info');
    return true;
  }

  private cancelDrag(): void {
    if (!this.origin) return;
    this.origin = null;
    this.ctx.store.cancelTransaction();
  }
}
