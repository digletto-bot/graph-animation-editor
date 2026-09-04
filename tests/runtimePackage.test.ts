// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../src/runtime/mount.ts';
import { installCanvasEnvironment } from './support/canvasEnvironment.ts';
import { createEmptyProject } from '../src/model/projectFactory.ts';
import { DEFAULT_PART_ID } from '../src/runtime/parts.ts';
import { serializeProject } from '../src/model/serialization.ts';
import type { AnimationProject } from '../src/runtime/types.ts';

/**
 * The package as an embedding site meets it: `mount()` and `<line-bird>`.
 *
 * Nothing here touches the editor. The canvas is backed by node-canvas so the
 * real drawing code runs, and the offscreen layers are real node surfaces
 * because node-canvas will not accept a jsdom element as a drawImage source.
 */
beforeAll(async () => {
  installCanvasEnvironment();
  // Registers <line-bird>. Imported after the canvas patches are in place.
  await import('../src/runtime/element.ts');
});

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function project(): AnimationProject {
  const built = createEmptyProject();
  built.settings.duration = 2;
  built.nodes.push({ id: 'n1', name: 'n1', partId: DEFAULT_PART_ID, width: 2, brightness: 1 });
  built.poses[0]!.positions = { n1: { x: 0.2, y: 0.5 } };
  return built;
}

/** A fetch that answers every request with the given project JSON. */
function stubFetch(body: unknown, ok = true) {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  const fetcher = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 404,
    statusText: ok ? 'OK' : 'Not Found',
    json: async () => JSON.parse(json) as unknown,
  }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

/** No IntersectionObserver by default; tests that need one install it. */
function stubIntersectionObserver() {
  const instances: Array<(visible: boolean) => void> = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        instances.push((visible) => callback([{ isIntersecting: visible }]));
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  return instances;
}

describe('mount()', () => {
  it('fetches a project, sizes a canvas into the host and plays it', async () => {
    stubFetch(JSON.parse(serializeProject(project())));
    const host = document.createElement('div');
    document.body.appendChild(host);

    const player = await mount(host, { src: '/bird.json' });

    expect(host.querySelector('canvas')).not.toBeNull();
    expect(player.playing).toBe(true);
    player.destroy();
  });

  it('takes an already-loaded document instead of a URL', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const player = await mount(host, { project: JSON.parse(serializeProject(project())) });
    expect(player.time).toBe(0);
    player.destroy();
  });

  it('mounts onto a canvas the page already has', async () => {
    const host = document.createElement('div');
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    document.body.appendChild(host);

    const player = await mount(canvas, { project: project(), trusted: true });
    expect(host.querySelectorAll('canvas')).toHaveLength(1);
    player.destroy();
  });

  it('refuses a document that is not a usable project', async () => {
    stubFetch({ version: 3, nodes: 'not an array' });
    const host = document.createElement('div');
    document.body.appendChild(host);

    await expect(mount(host, { src: '/broken.json' })).rejects.toThrow(/not a usable animation/i);
  });

  it('reports a fetch that failed, with the URL in the message', async () => {
    stubFetch({}, false);
    const host = document.createElement('div');
    document.body.appendChild(host);
    await expect(mount(host, { src: '/missing.json' })).rejects.toThrow(/missing\.json/);
  });

  it('skips validation for a document the caller vouches for', async () => {
    // Trusted means trusted: a shape the validator would reject goes straight
    // through, which is the point of the flag.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const player = await mount(host, { project: project(), trusted: true });
    expect(player.playing).toBe(true);
    player.destroy();
  });

  it('overrides the project loop setting when asked, and leaves it otherwise', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const looping = project();
    looping.settings.loop = true;
    const player = await mount(host, { project: looping, trusted: true, loop: false });
    expect(looping.settings.loop).toBe(false);
    player.destroy();

    const untouched = project();
    untouched.settings.loop = true;
    const second = await mount(host, { project: untouched, trusted: true });
    expect(untouched.settings.loop).toBe(true);
    second.destroy();
  });

  it('holds a still frame for a viewer who asked for less motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    const host = document.createElement('div');
    document.body.appendChild(host);

    const player = await mount(host, { project: project(), trusted: true });
    // Shown, but not moving.
    expect(player.playing).toBe(false);
    expect(host.querySelector('canvas')).not.toBeNull();
    player.destroy();
  });

  it('pauses while off screen and resumes when scrolled back', async () => {
    const observers = stubIntersectionObserver();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const player = await mount(host, { project: project(), trusted: true });

    observers[0]!(false);
    expect(player.playing).toBe(false);
    observers[0]!(true);
    expect(player.playing).toBe(true);
    player.destroy();
  });

  it('leaves a deliberately paused animation paused when it scrolls back', async () => {
    const observers = stubIntersectionObserver();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const player = await mount(host, { project: project(), trusted: true });

    player.pause();
    observers[0]!(false);
    observers[0]!(true);
    expect(player.playing).toBe(false);
    player.destroy();
  });
});

describe('<line-bird>', () => {
  /** Lets the element's own async load settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('is registered by importing the element entry point', () => {
    expect(customElements.get('line-bird')).toBeDefined();
  });

  it('loads its src and starts playing', async () => {
    stubFetch(JSON.parse(serializeProject(project())));
    const element = document.createElement('line-bird');
    element.setAttribute('src', '/bird.json');
    document.body.appendChild(element);
    await settle();

    expect(element.querySelector('canvas')).not.toBeNull();
    expect((element as { animation?: { playing: boolean } }).animation?.playing).toBe(true);
  });

  it('starts paused when told to', async () => {
    stubFetch(JSON.parse(serializeProject(project())));
    const element = document.createElement('line-bird');
    element.setAttribute('src', '/bird.json');
    element.setAttribute('paused', '');
    document.body.appendChild(element);
    await settle();

    expect((element as { animation?: { playing: boolean } }).animation?.playing).toBe(false);
  });

  it('tears the player down when it leaves the page', async () => {
    stubFetch(JSON.parse(serializeProject(project())));
    const element = document.createElement('line-bird');
    element.setAttribute('src', '/bird.json');
    document.body.appendChild(element);
    await settle();

    element.remove();
    expect((element as { animation?: unknown }).animation).toBeNull();
    expect(element.querySelector('canvas')).toBeNull();
  });

  it('reloads when its src changes', async () => {
    const fetcher = stubFetch(JSON.parse(serializeProject(project())));
    const element = document.createElement('line-bird');
    element.setAttribute('src', '/one.json');
    document.body.appendChild(element);
    await settle();

    element.setAttribute('src', '/two.json');
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(element.querySelectorAll('canvas')).toHaveLength(1);
  });

  it('raises an error event rather than throwing at the page', async () => {
    stubFetch({}, false);
    const element = document.createElement('line-bird');
    const failures: Event[] = [];
    element.addEventListener('error', (event) => failures.push(event));
    element.setAttribute('src', '/missing.json');
    document.body.appendChild(element);
    await settle();

    expect(failures).toHaveLength(1);
    expect((element as { animation?: unknown }).animation).toBeNull();
  });
});
