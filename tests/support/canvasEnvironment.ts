import { createCanvas, type Canvas } from 'canvas';

/**
 * Gives jsdom a real 2D canvas, so renderer code can be driven end to end.
 *
 * Each canvas element gets a node-canvas surface behind it. `drawImage` is
 * wrapped to swap an element for its surface, because node-canvas will not
 * accept a jsdom element as a source — and compositing offscreen part layers
 * is exactly what the renderer does on every frame.
 *
 * The elements stay real DOM nodes, so code under test can append them, query
 * them and read their layout the way it would in a browser.
 */
export function installCanvasEnvironment(): void {
  const backings = new WeakMap<HTMLCanvasElement, Canvas>();

  const proto = window.HTMLCanvasElement.prototype as unknown as {
    getContext: (type: string) => unknown;
  };
  proto.getContext = function getContext(this: HTMLCanvasElement, type: string) {
    if (type !== '2d') return null;
    const width = this.width || 300;
    const height = this.height || 150;
    let backing = backings.get(this);
    if (!backing || backing.width !== width || backing.height !== height) {
      backing = createCanvas(width, height);
      backings.set(this, backing);
    }

    const context = backing.getContext('2d') as unknown as CanvasRenderingContext2D;
    const drawImage = context.drawImage.bind(context) as (
      source: unknown,
      ...rest: number[]
    ) => void;
    context.drawImage = ((source: unknown, ...rest: number[]) =>
      drawImage(backings.get(source as HTMLCanvasElement) ?? source, ...rest)) as
      typeof context.drawImage;
    return context;
  };

  window.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;

  // jsdom does no layout, so every box would otherwise report zero size.
  window.HTMLElement.prototype.getBoundingClientRect = function bounds() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    };
  } as unknown as () => DOMRect;
}
