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
  const wrapped = new WeakSet<CanvasRenderingContext2D>();

  const proto = window.HTMLCanvasElement.prototype as unknown as {
    getContext: (type: string) => unknown;
  };
  proto.getContext = function getContext(this: HTMLCanvasElement, type: string) {
    if (type !== '2d') return null;
    const width = this.width || 300;
    const height = this.height || 150;
    let backing = backings.get(this);
    if (!backing) {
      backing = createCanvas(width, height);
      backings.set(this, backing);
    }

    const context = backing.getContext('2d') as unknown as CanvasRenderingContext2D;
    if (!wrapped.has(context)) {
      wrapped.add(context);
      const drawImage = context.drawImage.bind(context) as (
        source: unknown,
        ...rest: number[]
      ) => void;
      context.drawImage = ((source: unknown, ...rest: number[]) =>
        drawImage(backings.get(source as HTMLCanvasElement) ?? source, ...rest)) as
        typeof context.drawImage;
    }
    return context;
  };

  // A browser hands out one surface per element for its lifetime, and resizes
  // it the moment width or height is assigned. Doing that here rather than on
  // the next getContext() matters twice over: code holding a context from
  // before a resize keeps drawing where the page can see it, and a test reading
  // pixels back does not silently resize — and so clear — what it came to read.
  for (const axis of ['width', 'height'] as const) {
    const own = Object.getOwnPropertyDescriptor(window.HTMLCanvasElement.prototype, axis);
    if (!own?.set || !own.get) continue;
    Object.defineProperty(window.HTMLCanvasElement.prototype, axis, {
      configurable: true,
      get: own.get,
      set(this: HTMLCanvasElement, value: number) {
        own.set!.call(this, value);
        const backing = backings.get(this);
        // Assigning the dimension clears the surface, exactly as in a browser.
        if (backing) backing[axis] = this[axis] || (axis === 'width' ? 300 : 150);
      },
    });
  }

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
