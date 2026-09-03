import type { Point, Size } from '../model/types.ts';
import type { EditorStore } from '../state/EditorStore.ts';
import { MAX_ZOOM, MIN_ZOOM, fitCamera, panCamera, zoomAtPoint } from '../utils/coordinates.ts';

/**
 * Owns pan/zoom only. Camera changes never touch stored node positions — they
 * are a pure view transform applied when Konva shapes are synced.
 */
export class CameraController {
  private store: EditorStore;
  private panning = false;
  private lastPointer: Point = { x: 0, y: 0 };

  constructor(store: EditorStore) {
    this.store = store;
  }

  get isPanning(): boolean {
    return this.panning;
  }

  zoomAt(pointer: Point, deltaY: number): void {
    // Normalised zoom step: trackpads send many small deltas, wheels few large.
    const step = Math.exp(-deltaY * 0.0015);
    const factor = Math.min(2, Math.max(0.5, step));
    this.store.setCamera(zoomAtPoint(this.store.state.camera, pointer, factor, MIN_ZOOM, MAX_ZOOM));
  }

  zoomBy(factor: number, viewport: Size): void {
    const centre = { x: viewport.width / 2, y: viewport.height / 2 };
    this.store.setCamera(zoomAtPoint(this.store.state.camera, centre, factor, MIN_ZOOM, MAX_ZOOM));
  }

  beginPan(pointer: Point): void {
    this.panning = true;
    this.lastPointer = { ...pointer };
  }

  movePan(pointer: Point): void {
    if (!this.panning) return;
    const dx = pointer.x - this.lastPointer.x;
    const dy = pointer.y - this.lastPointer.y;
    this.lastPointer = { ...pointer };
    this.store.setCamera(panCamera(this.store.state.camera, dx, dy));
  }

  endPan(): void {
    this.panning = false;
  }

  fit(viewport: Size, padding = 56): void {
    this.store.setCamera(fitCamera(this.store.state.project.settings, viewport, padding));
  }

  /** "Reset view" — 1:1 zoom, artwork centred. */
  reset(viewport: Size): void {
    const { width, height } = this.store.state.project.settings;
    this.store.setCamera({
      scale: 1,
      x: (viewport.width - width) / 2,
      y: (viewport.height - height) / 2,
    });
  }
}
