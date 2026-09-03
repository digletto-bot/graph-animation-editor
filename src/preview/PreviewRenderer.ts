import type { AnimationProject, GraphPart } from '../model/types.ts';
import type { EditorStore } from '../state/EditorStore.ts';
import { GlowRenderer } from './glowRenderer.ts';
import { PoseSampler, advanceTime } from './interpolation.ts';
import { renderablePartsInOrder } from '../model/parts.ts';
import { OccluderResolver, type CompiledOccluder } from '../model/occluders.ts';
import { PartCanvasPool } from './partCanvas.ts';

const MAX_DPR = 2;
const TAU = Math.PI * 2;

/** Flat per-edge arrays for one part, rebuilt only when topology changes. */
interface PartDrawSet {
  partId: string;
  /** Pairs of indices into the sampler's interleaved position buffer. */
  edgeIndices: Int32Array;
  edgeWidths: Float32Array;
  edgeBrightness: Float32Array;
  edgePhase: Float32Array;
  /** Node indices belonging to this part, for the optional node dots. */
  nodeIndices: Int32Array;
}

/**
 * Preview mode renderer. Deliberately built on the raw Canvas 2D API with no
 * Konva anywhere in the import graph, so this module plus `interpolation.ts`,
 * `glowRenderer.ts`, `partCanvas.ts` and the two pure model helpers are all a
 * production site would need to ship.
 *
 * Each render-enabled part is drawn complete (halo, glow, core, node lights)
 * into its own reused offscreen canvas. Every enabled occluder targeting that
 * part is then punched out of it with `destination-out`, which removes the
 * blurred glow as well as the sharp lines — something painting the background
 * colour over the wing could never do. The masked part canvases are composited
 * back to front by `zIndex`.
 *
 * Editor state (lock, hide, solo, x-ray) is deliberately unreachable from here.
 */
export class PreviewRenderer {
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private store: EditorStore;
  private glow = new GlowRenderer();
  private sampler = new PoseSampler();
  private occluders = new OccluderResolver();
  private parts = new PartCanvasPool();

  private frameHandle: number | null = null;
  private lastTimestamp = 0;
  private resizeObserver: ResizeObserver;
  private dpr = 1;

  /** Reused per-frame scratch. Rebuilt only when topology changes. */
  private drawSets: PartDrawSet[] = [];
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
    this.parts.resize(deviceWidth, deviceHeight, this.dpr);

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

  /** Rebuild the per-part edge arrays. Runs on topology change only. */
  private syncTopology(project: AnimationProject): void {
    const key =
      `${project.nodes.map((node) => `${node.id}:${node.partId}`).join(',')}` +
      `|${project.edges.map((edge) => `${edge.id}:${edge.partId}`).join(',')}` +
      `|${project.parts.map((part) => `${part.id}:${part.zIndex}:${part.renderEnabled ? 1 : 0}`).join(',')}`;
    if (key === this.topologyKey) return;
    this.topologyKey = key;
    this.sampler.syncTopology(project);

    this.drawSets = renderablePartsInOrder(project).map((part) =>
      this.buildDrawSet(project, part),
    );
    // Release canvases for parts that were deleted or switched off.
    this.parts.retain(project.parts.map((part) => part.id));
  }

  private buildDrawSet(project: AnimationProject, part: GraphPart): PartDrawSet {
    const edges = project.edges.filter((edge) => edge.partId === part.id);
    const edgeIndices = new Int32Array(edges.length * 2);
    const edgeWidths = new Float32Array(edges.length);
    const edgeBrightness = new Float32Array(edges.length);
    const edgePhase = new Float32Array(edges.length);
    edges.forEach((edge, index) => {
      edgeIndices[index * 2] = this.sampler.indexOf(edge.from);
      edgeIndices[index * 2 + 1] = this.sampler.indexOf(edge.to);
      edgeWidths[index] = edge.width;
      edgeBrightness[index] = edge.brightness;
      // Stable per-edge phase so the shimmer never changes between sessions.
      edgePhase[index] = ((edge.seed % 997) / 997) * TAU;
    });

    const nodeIndices: number[] = [];
    project.nodes.forEach((node) => {
      if (node.partId !== part.id) return;
      const index = this.sampler.indexOf(node.id);
      if (index >= 0) nodeIndices.push(index);
    });

    return {
      partId: part.id,
      edgeIndices,
      edgeWidths,
      edgeBrightness,
      edgePhase,
      nodeIndices: Int32Array.from(nodeIndices),
    };
  }

  private draw(time: number): void {
    const state = this.store.state;
    const project = state.project;
    const settings = project.settings;
    const context = this.context;

    this.syncTopology(project);
    this.sampler.sample(project, time);
    this.occluders.sync(project, (nodeId) => this.sampler.indexOf(nodeId));

    const cssWidth = this.canvas.width / this.dpr;
    const cssHeight = this.canvas.height / this.dpr;

    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
    context.fillStyle = settings.backgroundColor;
    context.fillRect(0, 0, cssWidth, cssHeight);

    if (project.edges.length === 0 && project.nodes.length === 0) return;

    const strokeScale = this.rect.width / settings.width;

    // Back to front: each part is rendered whole, masked, then composited.
    for (const drawSet of this.drawSets) {
      const layer = this.parts.acquire(drawSet.partId);
      this.drawPart(layer, drawSet, time, strokeScale);
      this.applyMasks(layer, drawSet.partId, strokeScale);
      this.parts.composite(context, layer);
    }

    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
  }

  /** Full visual output for one part: halo, glow, core and optional dots. */
  private drawPart(
    target: CanvasRenderingContext2D,
    drawSet: PartDrawSet,
    time: number,
    strokeScale: number,
  ): void {
    const settings = this.store.state.project.settings;
    const positions = this.sampler.positions;
    const edgeCount = drawSet.edgeWidths.length;

    /* Pass 1 — wide faint halo, drawn once into the shared blur buffer. */
    const halo = this.glow.begin();
    halo.lineCap = 'round';
    halo.strokeStyle = settings.glowColor;
    for (let i = 0; i < edgeCount; i += 1) {
      const a = drawSet.edgeIndices[i * 2]!;
      const b = drawSet.edgeIndices[i * 2 + 1]!;
      if (a < 0 || b < 0) continue;
      const shimmer = 0.86 + 0.14 * Math.sin(time * 0.7 + drawSet.edgePhase[i]!);
      halo.globalAlpha = 0.16 * drawSet.edgeBrightness[i]! * shimmer;
      halo.lineWidth = Math.max(2, drawSet.edgeWidths[i]! * strokeScale * 5.5);
      halo.beginPath();
      halo.moveTo(
        this.rect.x + positions[a * 2]! * this.rect.width,
        this.rect.y + positions[a * 2 + 1]! * this.rect.height,
      );
      halo.lineTo(
        this.rect.x + positions[b * 2]! * this.rect.width,
        this.rect.y + positions[b * 2 + 1]! * this.rect.height,
      );
      halo.stroke();
    }
    this.glow.composite(target, 14, 0.9, this.dpr);

    /* Pass 2 — medium soft glow, additive. */
    target.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    target.globalCompositeOperation = 'lighter';
    target.lineCap = 'round';
    target.strokeStyle = settings.glowColor;
    for (let i = 0; i < edgeCount; i += 1) {
      const a = drawSet.edgeIndices[i * 2]!;
      const b = drawSet.edgeIndices[i * 2 + 1]!;
      if (a < 0 || b < 0) continue;
      const shimmer = 0.86 + 0.14 * Math.sin(time * 0.7 + drawSet.edgePhase[i]!);
      target.globalAlpha = 0.22 * drawSet.edgeBrightness[i]! * shimmer;
      target.lineWidth = Math.max(1.5, drawSet.edgeWidths[i]! * strokeScale * 2.4);
      target.beginPath();
      target.moveTo(
        this.rect.x + positions[a * 2]! * this.rect.width,
        this.rect.y + positions[a * 2 + 1]! * this.rect.height,
      );
      target.lineTo(
        this.rect.x + positions[b * 2]! * this.rect.width,
        this.rect.y + positions[b * 2 + 1]! * this.rect.height,
      );
      target.stroke();
    }

    /* Pass 3 — thin bright core. */
    target.strokeStyle = settings.lineColor;
    for (let i = 0; i < edgeCount; i += 1) {
      const a = drawSet.edgeIndices[i * 2]!;
      const b = drawSet.edgeIndices[i * 2 + 1]!;
      if (a < 0 || b < 0) continue;
      const shimmer = 0.9 + 0.1 * Math.sin(time * 0.55 + drawSet.edgePhase[i]!);
      target.globalAlpha = Math.min(1, 0.85 * drawSet.edgeBrightness[i]! * shimmer);
      target.lineWidth = Math.max(0.75, drawSet.edgeWidths[i]! * strokeScale);
      target.beginPath();
      target.moveTo(
        this.rect.x + positions[a * 2]! * this.rect.width,
        this.rect.y + positions[a * 2 + 1]! * this.rect.height,
      );
      target.lineTo(
        this.rect.x + positions[b * 2]! * this.rect.width,
        this.rect.y + positions[b * 2 + 1]! * this.rect.height,
      );
      target.stroke();
    }

    /* Optional node dots. */
    if (settings.showPreviewNodes) {
      target.globalCompositeOperation = 'source-over';
      target.fillStyle = settings.lineColor;
      const radius = Math.max(1, 1.6 * strokeScale * 1.2);
      target.globalAlpha = 0.75;
      for (let i = 0; i < drawSet.nodeIndices.length; i += 1) {
        const index = drawSet.nodeIndices[i]!;
        target.beginPath();
        target.arc(
          this.rect.x + positions[index * 2]! * this.rect.width,
          this.rect.y + positions[index * 2 + 1]! * this.rect.height,
          radius,
          0,
          TAU,
        );
        target.fill();
      }
    }

    target.globalAlpha = 1;
    target.globalCompositeOperation = 'source-over';
  }

  /**
   * Erases every enabled occluder that targets this part.
   *
   * The polygon is filled and then stroked with a width of twice the expansion,
   * which grows the hole outward by `maskExpansion` project pixels. The
   * expansion is converted through `strokeScale`, so it stays visually constant
   * at any panel size, and the context is left in device pixels transform so
   * one DPR-scaled setTransform covers both.
   */
  private applyMasks(target: CanvasRenderingContext2D, partId: string, strokeScale: number): void {
    const masks = this.occluders.forTarget(partId);
    if (masks.length === 0) return;
    const positions = this.sampler.positions;

    target.save();
    target.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    target.globalAlpha = 1;
    target.globalCompositeOperation = 'destination-out';
    // Any opaque paint erases under destination-out; the colour is irrelevant.
    target.fillStyle = '#000';
    target.strokeStyle = '#000';
    target.lineJoin = 'round';
    target.lineCap = 'round';

    for (const mask of masks) {
      this.fillOccluder(target, mask, positions, strokeScale);
    }

    target.globalCompositeOperation = 'source-over';
    target.restore();
  }

  /** Path the polygon straight from the interleaved buffer — no allocations. */
  private fillOccluder(
    target: CanvasRenderingContext2D,
    mask: CompiledOccluder,
    positions: Float32Array,
    strokeScale: number,
  ): void {
    target.beginPath();
    for (let i = 0; i < mask.indices.length; i += 1) {
      const index = mask.indices[i]!;
      const x = this.rect.x + positions[index * 2]! * this.rect.width;
      const y = this.rect.y + positions[index * 2 + 1]! * this.rect.height;
      if (i === 0) target.moveTo(x, y);
      else target.lineTo(x, y);
    }
    target.closePath();
    target.fill();
    if (mask.maskExpansion > 0) {
      // Stroking on the closed path grows the erased area by half the width.
      target.lineWidth = Math.max(0.5, mask.maskExpansion * strokeScale * 2);
      target.stroke();
    }
  }

  destroy(): void {
    this.stop();
    this.resizeObserver.disconnect();
  }
}
