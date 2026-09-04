import { AnimationPlayer } from './AnimationPlayer.ts';
import { validateProject } from './validate.ts';
import type { AnimationProject } from './types.ts';

export interface MountOptions {
  /** URL of a project JSON file. Give this or `project`. */
  src?: string;
  /** An already-loaded document. Validated unless `trusted` is set. */
  project?: unknown;
  /** Start playing once the first frame is ready. Default true. */
  autoplay?: boolean;
  /** Overrides the project's own loop setting when given. */
  loop?: boolean;
  /** Skips validation for a document you produced yourself. Default false. */
  trusted?: boolean;
  /** Stop the clock while the canvas is off screen. Default true. */
  pauseWhenOffscreen?: boolean;
  /** Hold a still frame for viewers who asked for less motion. Default true. */
  respectReducedMotion?: boolean;
}

/**
 * Puts an animation on a page in one call.
 *
 * `new AnimationPlayer(canvas, project)` is the whole runtime and stays
 * available for an app that has its own loading, layout and lifecycle. This is
 * for everyone else: it fetches, validates, sizes a canvas and applies the two
 * courtesies an embedded animation owes the page it is on — not burning frames
 * while scrolled out of view, and not moving at all for a viewer who asked for
 * stillness.
 */
export async function mount(
  target: string | HTMLElement,
  options: MountOptions = {},
): Promise<AnimationPlayer> {
  const host = resolveTarget(target);
  const project = await loadProject(options);

  if (options.loop !== undefined) project.settings.loop = options.loop;

  const canvas = host instanceof HTMLCanvasElement ? host : createCanvas(host);
  const player = new AnimationPlayer(canvas, project);
  player.start();

  if (options.respectReducedMotion !== false && prefersReducedMotion()) {
    // A single authored frame, held: the artwork is still shown, it just does
    // not move. Playback is left available to anything driving the player.
    player.renderOnce();
  } else if (options.autoplay !== false) {
    player.play();
  }

  if (options.pauseWhenOffscreen !== false) watchVisibility(player, canvas);
  return player;
}

function resolveTarget(target: string | HTMLElement): HTMLElement {
  const element = typeof target === 'string' ? document.querySelector(target) : target;
  if (!(element instanceof HTMLElement)) {
    throw new Error(`No element found to mount the animation on: ${String(target)}`);
  }
  return element;
}

/**
 * A canvas filling the host. The player letterboxes the project inside
 * whatever box its parent has, so the host is what decides the size.
 */
function createCanvas(host: HTMLElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(canvas);
  return canvas;
}

async function loadProject(options: MountOptions): Promise<AnimationProject> {
  const raw = options.src !== undefined ? await fetchProject(options.src) : options.project;
  if (raw === undefined) {
    throw new Error('mount() needs either a `src` URL or a `project` document.');
  }
  if (options.trusted) return raw as AnimationProject;

  const result = validateProject(raw);
  if (!result.ok) {
    throw new Error(`This is not a usable animation project. ${result.errors.slice(0, 2).join(' ')}`);
  }
  return result.project;
}

async function fetchProject(src: string): Promise<unknown> {
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`Could not load ${src}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Pauses while the canvas is off screen, and resumes only what was actually
 * running — a player someone paused deliberately must stay paused when it
 * scrolls back into view.
 */
function watchVisibility(player: AnimationPlayer, canvas: HTMLCanvasElement): void {
  if (typeof IntersectionObserver !== 'function') return;
  let pausedByScroll = false;

  const observer = new IntersectionObserver((entries) => {
    const visible = entries.some((entry) => entry.isIntersecting);
    if (!visible && player.playing) {
      pausedByScroll = true;
      player.pause();
      return;
    }
    if (visible && pausedByScroll) {
      pausedByScroll = false;
      player.play();
    }
  });

  observer.observe(canvas);
  player.addCleanup(() => observer.disconnect());
}
