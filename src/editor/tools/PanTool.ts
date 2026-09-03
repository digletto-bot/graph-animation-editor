import type { ToolId } from '../../model/types.ts';
import type { CameraController } from '../CameraController.ts';
import type { EditorContext, PointerInfo, Tool } from '../types.ts';

/** Drag to move the camera. Never touches geometry. */
export class PanTool implements Tool {
  readonly id: ToolId = 'pan';
  private ctx: EditorContext;
  private camera: CameraController;

  constructor(ctx: EditorContext, camera: CameraController) {
    this.ctx = ctx;
    this.camera = camera;
  }

  activate(): void {
    this.ctx.setCursor('grab');
  }

  deactivate(): void {
    this.camera.endPan();
    this.ctx.setCursor('default');
  }

  onPointerDown(info: PointerInfo): void {
    this.camera.beginPan(info.screen);
    this.ctx.setCursor('grabbing');
  }

  onPointerMove(info: PointerInfo): void {
    this.camera.movePan(info.screen);
  }

  onPointerUp(): void {
    this.camera.endPan();
    this.ctx.setCursor('grab');
  }
}
