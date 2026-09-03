import type { AnimationProject } from '../model/types.ts';
import type { EditorStore } from '../state/EditorStore.ts';
import { GlowRenderer } from './glowRenderer.ts';
import { PoseSampler, advanceTime } from './interpolation.ts';

const MAX_DPR = 2;
const TAU = Math.PI * 2;

/**
 * Preview mode renderer. Deliberately built on the raw Canvas 2D API with no
 * Konva anywhere in the import graph, so this module plus `interpolation.ts`
 * and `glowRenderer.ts` are all a production site would need to ship.
 *
 * Draws nothing but the artwork: no handles, no grid, no reference image.
 */
export class PreviewRenderer {
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private store: EditorStore;
  private glow = new GlowRenderer();
  private sampler = new PoseSampler();

  private frameHandle: number | null = null;
  private lastTimestamp = 0;
  private resizeObserver: ResizeObserver;
  private dpr = 1;

  /** Reused per-frame scratch. Rebuilt only when topology changes. */
  private edgeIndices = new Int32Array(0);
  private edgeWidths = new Float32Array(0);
  private edgeBrightness = new Float32Array(0);
  private edgePhase = new Float32Array(0);
  private topologyKey = '';

  /** Letterboxed artwork rect in CSS pixels. */
  private rect = { x: 0, y: 0, width: 0, height: 0 };

  constructor(canvas: HTMLCanvasElement, store: EditorStore) {
    this.canvas = canvas;
    this.store = store;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('2D canvas is not available in this browser.');
    this.context = context;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    if (canvas.parentElement) this.resizeObserver.observe(canvas.parentElement);
  }

  start(): void {
    if (this.frameHandle !== null) return;
    this.resize();
    this.lastTimestamp = performance.now();
    const loop = (timestamp: number) => {
      this.frameHandle = requestAnimationFrame(loop);
      this.tick(timestamp);
    };
    this.frameHandle = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.frameHandle === null) return;
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  exportDataUrl(): string {
    return this.canvas.toDataURL('image/png');
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const bounds = parent.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.floor(bounds.width));
    const cssHeight = Math.max(1, Math.floor(bounds.height));
    this.dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);

    const deviceWidth = Math.floor(cssWidth * this.dpr);
    const deviceHeight = Math.floor(cssHeight * this.dpr);
    if (this.canvas.width !== deviceWidth || this.canvas.height !== deviceHeight) {
      this.canvas.width = deviceWidth;
      this.canvas.height = deviceHeight;
    }
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.glow.resize(deviceWidth, deviceHeight, this.dpr);

    // Letterbox: keep the project's aspect ratio whatever the panel size.
    const settings = this.store.state.project.settings;
    const scale = Math.min(cssWidth / settings.width, cssHeight / settings.height);
    const width = settings.width * scale;
    const height = settings.height * scale;
    this.rect = {
      x: (cssWidth - width) / 2,
      y: (cssHeight - height) / 2,
      width,
      height,
    };
    this.renderOnce();
  }

  /** Draw a single frame at the current playback time (used when paused). */
  renderOnce(): void {
    this.draw(this.store.state.playback.time);
  }

  private tick(timestamp: number): void {
    const delta = Math.min(0.1, (timestamp - this.lastTimestamp) / 1000);
    this.lastTimestamp = timestamp;
    const state = this.store.state;

    if (state.playback.playing) {
      const settings = state.project.settings;
      const result = advanceTime(state.playback.time, delta, settings.duration, settings.loop);
      state.playback.time = result.time;
      if (result.finished) {
        state.playback.playing = false;
        this.store.emit(['playback']);
      } else {
        this.store.emit(['playback'], 'raf');
      }
    }
    this.draw(state.playback.time);
  }

  /** Rebuild the flat per-edge arrays. Runs on topology change only. */
  private syncTopology(project: AnimationProject): void {
    const key = `${project.nodes.length}:${project.edges.map((edge) => edge.id).join(',')}`;
    if (key === this.topologyKey) return;
    this.topologyKey = key;
    this.sampler.syncTopology(project);

    const count = project.edges.length;
    if (this.edgeIndices.length !== count * 2) {
      this.edgeIndices = new Int32Array(count * 2);
      this.edgeWidths = new Float32Array(count);
      this.edgeBrightness = new Float32Array(count);
      this.edgePhase = new Float32Array(count);
    }
    project.edges.forEach((edge, index) => {
      this.edgeIndices[index * 2] = this.sampler.indexOf(edge.from);
      this.edgeIndices[index * 2 + 1] = this.sampler.indexOf(edge.to);
      this.edgeWidths[index] = edge.width;
      this.edgeBrightness[index] = edge.brightness;
      // Stable per-edge phase so the shimmer never changes between sessions.
      this.edgePhase[index] = ((edge.seed % 997) / 997) * TAU;
    });
  }

  private draw(time: number): void {
    const state = this.store.state;
    const project = state.project;
    const settings = project.settings;
    const context = this.context;

    this.syncTopology(project);
    this.sampler.sample(project, time);

    const cssWidth = this.canvas.width / this.dpr;
    const cssHeight = this.canvas.height / this.dpr;

    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
    context.fillStyle = settings.backgroundColor;
    context.fillRect(0, 0, cssWidth, cssHeight);

    if (project.edges.length === 0 && project.nodes.length === 0) return;

    const strokeScale = this.rect.width / settings.width;
    const positions = this.sampler.positions;
    const edgeCount = project.edges.length;

    /* Pass 1 — wide faint halo, drawn once into the offscreen buffer. */
    const halo = this.glow.begin();
    halo.lineCap = 'round';
    halo.strokeStyle = settings.glowColor;
    for (let i = 0; i < edgeCount; i += 1) {
      const a = this.edgeIndices[i * 2]!;
      const b = this.edgeIndices[i * 2 + 1]!;
      if (a < 0 || b < 0) continue;
      const shimmer = 0.86 + 0.14 * Math.sin(time * 0.7 + this.edgePhase[i]!);
      halo.globalAlpha = 0.16 * this.edgeBrightness[i]! * shimmer;
      halo.lineWidth = Math.max(2, this.edgeWidths[i]! * strokeScale * 5.5);
      halo.beginPath();
      halo.moveTo(this.rect.x + positions[a * 2]! * this.rect.width, this.rect.y + positions[a * 2 + 1]! * this.rect.height);
      halo.lineTo(this.rect.x + positions[b * 2]! * this.rect.width, this.rect.y + positions[b * 2 + 1]! * this.rect.height);
      halo.stroke();
    }
    this.glow.composite(context, 14, 0.9, this.dpr);

    /* Pass 2 — medium soft glow, additive, directly on the target. */
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.globalCompositeOperation = 'lighter';
    context.lineCap = 'round';
    context.strokeStyle = settings.glowColor;
    for (let i = 0; i < edgeCount; i += 1) {
      const a = this.edgeIndices[i * 2]!;
      const b = this.edgeIndices[i * 2 + 1]!;
      if (a < 0 || b < 0) continue;
      const shimmer = 0.86 + 0.14 * Math.sin(time * 0.7 + this.edgePhase[i]!);
      context.globalAlpha = 0.22 * this.edgeBrightness[i]! * shimmer;
      context.lineWidth = Math.max(1.5, this.edgeWidths[i]! * strokeScale * 2.4);
      context.beginPath();
      context.moveTo(this.rect.x + positions[a * 2]! * this.rect.width, this.rect.y + positions[a * 2 + 1]! * this.rect.height);
      context.lineTo(this.rect.x + positions[b * 2]! * this.rect.width, this.rect.y + positions[b * 2 + 1]! * this.rect.height);
      context.stroke();
    }

    /* Pass 3 — thin bright core. */
    context.strokeStyle = settings.lineColor;
    for (let i = 0; i < edgeCount; i += 1) {
      const a = this.edgeIndices[i * 2]!;
      const b = this.edgeIndices[i * 2 + 1]!;
      if (a < 0 || b < 0) continue;
      const shimmer = 0.9 + 0.1 * Math.sin(time * 0.55 + this.edgePhase[i]!);
      context.globalAlpha = Math.min(1, 0.85 * this.edgeBrightness[i]! * shimmer);
      context.lineWidth = Math.max(0.75, this.edgeWidths[i]! * strokeScale);
      context.beginPath();
      context.moveTo(this.rect.x + positions[a * 2]! * this.rect.width, this.rect.y + positions[a * 2 + 1]! * this.rect.height);
      context.lineTo(this.rect.x + positions[b * 2]! * this.rect.width, this.rect.y + positions[b * 2 + 1]! * this.rect.height);
      context.stroke();
    }

    /* Optional node dots. */
    if (settings.showPreviewNodes) {
      context.fillStyle = settings.lineColor;
      const radius = Math.max(1, 1.6 * strokeScale * 1.2);
      for (let i = 0; i < project.nodes.length; i += 1) {
        context.globalAlpha = 0.75;
        context.beginPath();
        context.arc(
          this.rect.x + positions[i * 2]! * this.rect.width,
          this.rect.y + positions[i * 2 + 1]! * this.rect.height,
          radius,
          0,
          TAU,
        );
        context.fill();
      }
    }

    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
  }

  destroy(): void {
    this.stop();
    this.resizeObserver.disconnect();
  }
}
