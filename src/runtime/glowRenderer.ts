/**
 * Glow compositor.
 *
 * The wide halo for the *entire* network is drawn once into an offscreen
 * canvas, blurred once, and composited back additively. That is a single blur
 * per frame instead of one shadow-blur per edge, which is what keeps this cheap
 * at 500+ edges.
 */
export class GlowRenderer {
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private supportsFilter: boolean;

  constructor() {
    this.canvas = document.createElement('canvas');
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('2D canvas is not available in this browser.');
    this.context = context;
    this.supportsFilter = typeof this.context.filter === 'string';
  }

  /** Resize to match the target's device-pixel dimensions. */
  resize(deviceWidth: number, deviceHeight: number, dpr: number): void {
    if (this.canvas.width !== deviceWidth || this.canvas.height !== deviceHeight) {
      this.canvas.width = deviceWidth;
      this.canvas.height = deviceHeight;
    }
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Clears the halo buffer and returns the context to draw the network into. */
  begin(): CanvasRenderingContext2D {
    const { width, height } = this.canvas;
    this.context.save();
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.clearRect(0, 0, width, height);
    this.context.restore();
    this.context.globalCompositeOperation = 'lighter';
    return this.context;
  }

  /**
   * Blur the halo buffer and add it under the sharp pass. Drawn in device
   * pixels so the blur radius stays visually constant across DPRs.
   */
  composite(target: CanvasRenderingContext2D, blurPx: number, alpha: number, dpr: number): void {
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalCompositeOperation = 'lighter';
    target.globalAlpha = alpha;
    if (this.supportsFilter && blurPx > 0) {
      target.filter = `blur(${(blurPx * dpr).toFixed(2)}px)`;
    }
    target.drawImage(this.canvas, 0, 0);
    target.filter = 'none';
    target.restore();
  }
}
