/**
 * Offscreen canvases, one per rendered part.
 *
 * Allocating a canvas per frame would be ruinous, so canvases are created once
 * per part id, kept at the target's device-pixel size, and cleared on acquire.
 * A part canvas is transparent (`alpha: true`) precisely so `destination-out`
 * can punch real holes through it before it is composited.
 */
export interface PartLayer {
  partId: string;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

export class PartCanvasPool {
  private layers = new Map<string, PartLayer>();
  private deviceWidth = 0;
  private deviceHeight = 0;
  private dpr = 1;

  resize(deviceWidth: number, deviceHeight: number, dpr: number): void {
    this.deviceWidth = deviceWidth;
    this.deviceHeight = deviceHeight;
    this.dpr = dpr;
    for (const layer of this.layers.values()) this.applySize(layer);
  }

  private applySize(layer: PartLayer): void {
    if (layer.canvas.width !== this.deviceWidth || layer.canvas.height !== this.deviceHeight) {
      layer.canvas.width = this.deviceWidth;
      layer.canvas.height = this.deviceHeight;
    }
    layer.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Returns a cleared, correctly sized layer for `partId`. */
  acquire(partId: string): CanvasRenderingContext2D {
    let layer = this.layers.get(partId);
    if (!layer) {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: true });
      if (!context) throw new Error('2D canvas is not available in this browser.');
      layer = { partId, canvas, context };
      this.layers.set(partId, layer);
    }
    this.applySize(layer);

    const context = layer.context;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
    context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    context.restore();
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
    return context;
  }

  /**
   * Composites a finished part over the main canvas in device pixels, so the
   * layer lands 1:1 regardless of the transform the caller was using.
   */
  composite(target: CanvasRenderingContext2D, layerContext: CanvasRenderingContext2D): void {
    const canvas = layerContext.canvas;
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalCompositeOperation = 'source-over';
    target.globalAlpha = 1;
    target.filter = 'none';
    target.drawImage(canvas, 0, 0);
    target.restore();
  }

  /** Drops canvases for parts that no longer exist. */
  retain(partIds: Iterable<string>): void {
    const keep = new Set(partIds);
    for (const id of [...this.layers.keys()]) {
      if (!keep.has(id)) this.layers.delete(id);
    }
  }
}
