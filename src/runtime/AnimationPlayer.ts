import type { AnimationProject, GraphEdge, GraphNode, GraphPart } from './types.ts';
import { GlowRenderer } from './glowRenderer.ts';
import { PoseSampler, advanceTime } from './interpolation.ts';
import { renderablePartsInOrder } from './parts.ts';
import { OccluderResolver, type CompiledOccluder } from './occluders.ts';
import { PartCanvasPool } from './partCanvas.ts';
import {
  NODE_HELPER_ALPHA,
  NODE_HELPER_WIDTH,
  nodeCoreAlpha,
  nodeDotRadius,
  nodeGlowAlpha,
  nodeGlowRadius,
} from './nodeDots.ts';

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
  /** The edges these arrays were built from, in the same order. */
  edges: GraphEdge[];
  /** The nodes the dot arrays were built from, in the same order. */
  nodes: GraphNode[];
  /** Node indices belonging to this part, for the optional node dots. */
  nodeIndices: Int32Array;
  /** Dot radius per node, parallel to `nodeIndices`. */
  nodeWidths: Float32Array;
  /** Opacity multiplier per node, parallel to `nodeIndices`. */
  nodeBrightness: Float32Array;
}

/** Told each frame where the clock got to, and whether it just ran out. */
export type TimeListener = (time: number, finished: boolean) => void;

/**
 * Plays an animation project onto a canvas.
 *
 * This is the whole runtime: the class plus `interpolation.ts`,
 * `glowRenderer.ts`, `partCanvas.ts`, `nodeDots.ts` and the two pure document
 * helpers are all an embedding site needs to ship. It owns a project, a
 * playhead and a render loop, and knows nothing about the editor — the editor
 * binds its own store to one of these through `app/PreviewBridge.ts`.
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
export class AnimationPlayer {
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private project: AnimationProject;
  /** Seconds into the animation. */
  private currentTime = 0;
  private isPlaying = false;
  /** Called on every frame the clock advances. */
  onTime: TimeListener | null = null;
  private glow = new GlowRenderer();
  private sampler = new PoseSampler();
  private occluders = new OccluderResolver();
  private parts = new PartCanvasPool();

  private frameHandle: number | null = null;
  private lastTimestamp = 0;
  private resizeObserver: ResizeObserver;
  private dpr = 1;
  /** Torn down with the player: observers and listeners added around it. */
  private cleanups: Array<() => void> = [];

  /** Reused per-frame scratch. Rebuilt only when topology changes. */
  private drawSets: PartDrawSet[] = [];
  private topologyKey = '';

  /** Letterboxed artwork rect in CSS pixels. */
  private rect = { x: 0, y: 0, width: 0, height: 0 };

  constructor(canvas: HTMLCanvasElement, project: AnimationProject) {
    this.canvas = canvas;
    this.project = project;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('2D canvas is not available in this browser.');
    this.context = context;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    if (canvas.parentElement) this.resizeObserver.observe(canvas.parentElement);
  }

  /* ------------------------------ transport --------------------------- */

  get time(): number {
    return this.currentTime;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  /**
   * Swaps in a project. The editor mutates its project in place, so this is
   * only a real change when the whole document is replaced — but the redraw is
   * wanted either way while the loop is not running.
   */
  setProject(project: AnimationProject): void {
    this.project = project;
    if (this.frameHandle === null) this.renderOnce();
  }

  /** Moves the playhead. Clamped to the project, and drawn if nothing else is. */
  seek(time: number): void {
    const duration = Math.max(0.001, this.project.settings.duration);
    this.currentTime = Math.min(Math.max(time, 0), duration);
    if (this.frameHandle === null) this.renderOnce();
  }

  setPlaying(playing: boolean): void {
    this.isPlaying = playing;
    // A fresh baseline: the gap since the last frame is not elapsed animation.
    this.lastTimestamp = performance.now();
  }

  play(): void {
    this.setPlaying(true);
    this.start();
  }

  pause(): void {
    this.setPlaying(false);
  }

  /**
   * Runs the render loop. It draws every frame whether or not the clock is
   * running, so a seek from outside shows up without anyone asking for it.
   */
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
    const settings = this.project.settings;
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

  /** Draw a single frame at the current playhead (used when paused). */
  renderOnce(): void {
    this.draw(this.currentTime);
  }

  private tick(timestamp: number): void {
    // Clamped at both ends. A long gap (a backgrounded tab) must not teleport
    // the animation, and the first frame after play() can carry a timestamp
    // from *before* the baseline was taken — which would run the clock
    // backwards past zero.
    const elapsed = (timestamp - this.lastTimestamp) / 1000;
    const delta = Math.min(0.1, Math.max(0, elapsed));
    this.lastTimestamp = timestamp;

    if (this.isPlaying) {
      const settings = this.project.settings;
      const result = advanceTime(this.currentTime, delta, settings.duration, settings.loop);
      this.currentTime = result.time;
      if (result.finished) this.isPlaying = false;
      this.onTime?.(result.time, result.finished);
    }
    this.draw(this.currentTime);
  }

  /** Rebuild the per-part edge arrays. Runs on topology change only. */
  /**
   * Copies the current width and brightness of every edge and node into the
   * draw arrays.
   *
   * The topology key deliberately tracks structure only, so an appearance edit
   * never rebuilt the draw sets and the preview kept rendering stale values.
   * Refreshing in place each frame is O(n) numeric writes into buffers that
   * already exist — no allocation, and no way for the preview to fall behind.
   */
  private refreshAppearance(): void {
    for (const drawSet of this.drawSets) {
      for (let i = 0; i < drawSet.edges.length; i += 1) {
        const edge = drawSet.edges[i]!;
        drawSet.edgeWidths[i] = edge.width;
        drawSet.edgeBrightness[i] = edge.brightness;
      }
      for (let i = 0; i < drawSet.nodes.length; i += 1) {
        const node = drawSet.nodes[i]!;
        drawSet.nodeWidths[i] = node.width;
        drawSet.nodeBrightness[i] = node.brightness;
      }
    }
  }

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
    const nodeWidths: number[] = [];
    const nodeBrightness: number[] = [];
    const nodes: GraphNode[] = [];
    project.nodes.forEach((node) => {
      if (node.partId !== part.id) return;
      const index = this.sampler.indexOf(node.id);
      if (index < 0) return;
      nodes.push(node);
      nodeIndices.push(index);
      nodeWidths.push(node.width);
      nodeBrightness.push(node.brightness);
    });

    return {
      partId: part.id,
      edges,
      nodes,
      edgeIndices,
      edgeWidths,
      edgeBrightness,
      edgePhase,
      nodeIndices: Int32Array.from(nodeIndices),
      nodeWidths: Float32Array.from(nodeWidths),
      nodeBrightness: Float32Array.from(nodeBrightness),
    };
  }

  private draw(time: number): void {
    const project = this.project;
    const settings = project.settings;
    const context = this.context;

    this.syncTopology(project);
    this.refreshAppearance();
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
    const settings = this.project.settings;
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

    /* Pass 4 — node points, additive halo. Artwork, not a debug overlay. */
    const nodeCount = drawSet.nodeIndices.length;
    target.globalCompositeOperation = 'lighter';
    target.fillStyle = settings.glowColor;
    for (let i = 0; i < nodeCount; i += 1) {
      const brightness = drawSet.nodeBrightness[i]!;
      const alpha = nodeGlowAlpha(brightness);
      // A node turned fully down draws nothing at all, which is how a node is
      // hidden from the output without deleting it.
      if (alpha <= 0) continue;
      const index = drawSet.nodeIndices[i]!;
      target.globalAlpha = alpha;
      target.beginPath();
      target.arc(
        this.rect.x + positions[index * 2]! * this.rect.width,
        this.rect.y + positions[index * 2 + 1]! * this.rect.height,
        nodeGlowRadius(drawSet.nodeWidths[i]!, strokeScale),
        0,
        TAU,
      );
      target.fill();
    }

    /* Pass 5 — node cores. */
    target.globalCompositeOperation = 'source-over';
    target.fillStyle = settings.lineColor;
    for (let i = 0; i < nodeCount; i += 1) {
      const alpha = nodeCoreAlpha(drawSet.nodeBrightness[i]!);
      if (alpha <= 0) continue;
      const index = drawSet.nodeIndices[i]!;
      target.globalAlpha = alpha;
      target.beginPath();
      target.arc(
        this.rect.x + positions[index * 2]! * this.rect.width,
        this.rect.y + positions[index * 2 + 1]! * this.rect.height,
        nodeDotRadius(drawSet.nodeWidths[i]!, strokeScale),
        0,
        TAU,
      );
      target.fill();
    }

    /* Helper overlay — flat, uniform, and independent of node appearance. */
    if (settings.showPreviewNodes) {
      target.globalCompositeOperation = 'source-over';
      target.fillStyle = settings.lineColor;
      target.globalAlpha = NODE_HELPER_ALPHA;
      const helperRadius = nodeDotRadius(NODE_HELPER_WIDTH, strokeScale);
      for (let i = 0; i < nodeCount; i += 1) {
        const index = drawSet.nodeIndices[i]!;
        target.beginPath();
        target.arc(
          this.rect.x + positions[index * 2]! * this.rect.width,
          this.rect.y + positions[index * 2 + 1]! * this.rect.height,
          helperRadius,
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

  /**
   * Registers work to undo when the player is destroyed, so a helper that
   * wires observers around it does not need its own teardown handle.
   */
  addCleanup(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  /** Stops the loop and releases the resize observer and any extras. */
  destroy(): void {
    this.stop();
    this.resizeObserver.disconnect();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }
}
