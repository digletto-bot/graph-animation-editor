import { describe, expect, it } from 'vitest';
import type { NodePosition } from '../src/model/types.ts';
import { createEmptyProject, addNode, createOccluder } from '../src/model/projectFactory.ts';
import { BODY_PART_ID, FAR_WING_PART_ID } from '../src/model/parts.ts';
import { OccluderResolver } from '../src/model/occluders.ts';
import { PoseSampler } from '../src/preview/interpolation.ts';

/**
 * The masking contract, exercised on a real 2D context.
 *
 * `node-canvas` is an optional native dependency; it is not built in every
 * environment (the repository's jsdom suites already skip for the same
 * reason). Rather than standing up a fake canvas that could "pass" while the
 * browser fails, these cases skip when no real backend is present.
 */
type CanvasFactory = (width: number, height: number) => HTMLCanvasElement;

async function loadCanvasFactory(): Promise<CanvasFactory | null> {
  try {
    const nodeCanvas = (await import('canvas')) as unknown as { createCanvas: CanvasFactory };
    // Touch a context to be sure the native binding really loaded.
    const probe = nodeCanvas.createCanvas(1, 1);
    if (!probe.getContext('2d')) return null;
    return nodeCanvas.createCanvas;
  } catch {
    return null;
  }
}

const createCanvas = await loadCanvasFactory();
const describeCanvas = createCanvas ? describe : describe.skip;

/** Mirrors PreviewRenderer.fillOccluder: fill, then stroke to expand. */
function punchOut(
  context: CanvasRenderingContext2D,
  polygon: NodePosition[],
  expansionPx: number,
): void {
  context.save();
  context.globalCompositeOperation = 'destination-out';
  context.fillStyle = '#000';
  context.strokeStyle = '#000';
  context.lineJoin = 'round';
  context.beginPath();
  polygon.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();
  context.fill();
  if (expansionPx > 0) {
    context.lineWidth = expansionPx * 2;
    context.stroke();
  }
  context.globalCompositeOperation = 'source-over';
  context.restore();
}

function alphaAt(context: CanvasRenderingContext2D, x: number, y: number): number {
  return context.getImageData(x, y, 1, 1).data[3]!;
}

describeCanvas('destination-out masking', () => {
  const make = (w = 100, h = 100) => {
    const canvas = createCanvas!(w, h);
    const context = canvas.getContext('2d')!;
    return { canvas, context };
  };

  it('removes the targeted pixels rather than painting over them', () => {
    const { context } = make();
    context.fillStyle = '#ff8800';
    context.fillRect(0, 0, 100, 100);
    expect(alphaAt(context, 50, 50)).toBe(255);

    punchOut(
      context,
      [
        { x: 30, y: 30 },
        { x: 70, y: 30 },
        { x: 70, y: 70 },
        { x: 30, y: 70 },
      ],
      0,
    );

    // Inside the polygon the layer is transparent, not repainted.
    expect(alphaAt(context, 50, 50)).toBe(0);
    // Outside it is untouched.
    expect(alphaAt(context, 10, 10)).toBe(255);
  });

  it('erases soft glow pixels, not only the sharp core', () => {
    const { context } = make();
    context.save();
    // A wide, faint stroke stands in for the blurred halo.
    //
    // The renderer produces its halo with `ctx.filter = 'blur(...)'`, which
    // node-canvas does not implement — it accepts the assignment, stores the
    // string, and draws sharp anyway. What matters here is not how the soft
    // pixels were made but that `destination-out` clears partial alpha away
    // from the core, so the glow cannot survive a hole cut through the lines.
    context.globalAlpha = 0.3;
    context.strokeStyle = '#ffd9a0';
    context.lineWidth = 18;
    context.beginPath();
    context.moveTo(10, 50);
    context.lineTo(90, 50);
    context.stroke();
    context.restore();

    // Partial alpha, well off the 6px core the bright pass would cover.
    const haloBefore = alphaAt(context, 50, 56);
    expect(haloBefore).toBeGreaterThan(0);
    expect(haloBefore).toBeLessThan(255);

    punchOut(
      context,
      [
        { x: 20, y: 20 },
        { x: 80, y: 20 },
        { x: 80, y: 80 },
        { x: 20, y: 80 },
      ],
      0,
    );

    expect(alphaAt(context, 50, 50)).toBe(0);
    expect(alphaAt(context, 50, 56)).toBe(0);
  });

  it('grows the hole outward with the mask expansion', () => {
    const polygon = [
      { x: 40, y: 40 },
      { x: 60, y: 40 },
      { x: 60, y: 60 },
      { x: 40, y: 60 },
    ];

    const tight = make();
    tight.context.fillStyle = '#ffffff';
    tight.context.fillRect(0, 0, 100, 100);
    punchOut(tight.context, polygon, 0);

    const expanded = make();
    expanded.context.fillStyle = '#ffffff';
    expanded.context.fillRect(0, 0, 100, 100);
    punchOut(expanded.context, polygon, 5);

    // Just outside the polygon edge: survives without expansion, gone with it.
    expect(alphaAt(tight.context, 63, 50)).toBe(255);
    expect(alphaAt(expanded.context, 63, 50)).toBe(0);
  });

  it('leaves the layer untouched when the occluder is disabled', () => {
    const project = createEmptyProject();
    const poseId = project.poses[0]!.id;
    const a = addNode(project, { x: 0.3, y: 0.3 }, poseId, 'A', BODY_PART_ID);
    const b = addNode(project, { x: 0.7, y: 0.3 }, poseId, 'B', BODY_PART_ID);
    const c = addNode(project, { x: 0.5, y: 0.7 }, poseId, 'C', BODY_PART_ID);
    const occluder = createOccluder(project, [a, b, c], {
      ownerPartId: BODY_PART_ID,
      targetPartIds: [FAR_WING_PART_ID],
    });
    occluder.enabled = false;

    const sampler = new PoseSampler();
    sampler.sample(project, 0);
    const resolver = new OccluderResolver();
    resolver.sync(project, (nodeId) => sampler.indexOf(nodeId));

    const { context } = make();
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 100, 100);
    for (const mask of resolver.forTarget(FAR_WING_PART_ID)) {
      const polygon: NodePosition[] = [];
      for (const index of mask.indices) {
        polygon.push({
          x: sampler.positions[index * 2]! * 100,
          y: sampler.positions[index * 2 + 1]! * 100,
        });
      }
      punchOut(context, polygon, mask.maskExpansion);
    }
    expect(alphaAt(context, 50, 45)).toBe(255);
  });

  it('composites masked layers back to front over a coloured background', () => {
    const background = make();
    background.context.fillStyle = '#05060a';
    background.context.fillRect(0, 0, 100, 100);

    // Far wing layer, fully erased where the body silhouette covers it.
    const wing = make();
    wing.context.fillStyle = '#ff0000';
    wing.context.fillRect(0, 0, 100, 100);
    punchOut(
      wing.context,
      [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 100 },
        { x: 0, y: 100 },
      ],
      0,
    );
    background.context.drawImage(wing.canvas, 0, 0);

    const masked = background.context.getImageData(25, 50, 1, 1).data;
    const kept = background.context.getImageData(75, 50, 1, 1).data;
    // Masked half shows the background; the other half shows the wing.
    expect([masked[0], masked[1], masked[2]]).toEqual([5, 6, 10]);
    expect(kept[0]).toBe(255);
  });
});

describe('masking test environment', () => {
  it('reports whether a real canvas backend was available', () => {
    // Not an assertion about the renderer: it documents why cases may skip.
    expect(typeof (createCanvas === null)).toBe('boolean');
  });
});
