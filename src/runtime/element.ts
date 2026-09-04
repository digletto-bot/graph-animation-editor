import { mount } from './mount.ts';
import type { AnimationPlayer } from './AnimationPlayer.ts';

/**
 * `<line-bird src="bird.json">` — the animation as one HTML tag.
 *
 * Importing this module registers the element. It is a separate entry point
 * from the player itself so an app that mounts its own canvas never pays for
 * it, and so importing the runtime has no side effect on the page.
 *
 * ```html
 * <script type="module" src="https://esm.sh/line-bird/element"></script>
 * <line-bird src="/bird.json" style="height: 320px"></line-bird>
 * ```
 */
export class LineBirdElement extends HTMLElement {
  private player: AnimationPlayer | null = null;
  /** Guards against a slow load resolving after the element was removed. */
  private live = false;

  static get observedAttributes(): string[] {
    return ['src'];
  }

  connectedCallback(): void {
    this.live = true;
    // A replaced element has no intrinsic size, and a zero-height box would
    // render nothing at all. Author styles win: this only fills a gap.
    if (!this.style.display) this.style.display = 'block';
    void this.load();
  }

  disconnectedCallback(): void {
    this.live = false;
    this.teardown();
  }

  attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
    if (name !== 'src' || previous === next || !this.live) return;
    this.teardown();
    void this.load();
  }

  /** The player driving this element, once it has loaded. */
  get animation(): AnimationPlayer | null {
    return this.player;
  }

  play(): void {
    this.player?.play();
  }

  pause(): void {
    this.player?.pause();
  }

  private async load(): Promise<void> {
    const src = this.getAttribute('src');
    if (!src) return;

    try {
      const player = await mount(this, {
        src,
        autoplay: !this.hasAttribute('paused'),
        // Absent means "whatever the project says", so it is only passed when
        // the attribute is actually present.
        ...(this.hasAttribute('loop') ? { loop: this.getAttribute('loop') !== 'false' } : {}),
        pauseWhenOffscreen: this.getAttribute('pause-offscreen') !== 'false',
        respectReducedMotion: this.getAttribute('reduced-motion') !== 'ignore',
      });
      if (!this.live) {
        // Removed from the page while the fetch was in flight.
        player.destroy();
        return;
      }
      this.player = player;
      this.dispatchEvent(new CustomEvent('load'));
    } catch (error) {
      // A broken animation must not take the page down with it. The detail is
      // there for anyone listening; the element simply stays empty.
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    }
  }

  private teardown(): void {
    this.player?.destroy();
    this.player = null;
    this.replaceChildren();
  }
}

/** Registers `<line-bird>`, unless something already claimed the name. */
export function defineLineBirdElement(tag = 'line-bird'): void {
  if (typeof customElements === 'undefined' || customElements.get(tag)) return;
  customElements.define(tag, LineBirdElement);
}

defineLineBirdElement();
