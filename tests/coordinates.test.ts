import { describe, expect, it } from 'vitest';
import {
  clamp01,
  fitCamera,
  isInsideNormalizedBounds,
  normalizedToProject,
  normalizedToStage,
  projectToNormalized,
  projectToStage,
  stageToNormalized,
  stageToProject,
  zoomAtPoint,
} from '../src/utils/coordinates.ts';
import { createDefaultSettings } from '../src/model/projectFactory.ts';
import { pointInPolygon, rectContainsPoint, rectFromPoints } from '../src/utils/geometry.ts';

const settings = createDefaultSettings(); // 1200 x 800

describe('coordinate conversion', () => {
  it('maps normalized to project pixels', () => {
    expect(normalizedToProject({ x: 0.5, y: 0.25 }, settings)).toEqual({ x: 600, y: 200 });
  });

  it('maps project pixels back to normalized', () => {
    expect(projectToNormalized({ x: 600, y: 200 }, settings)).toEqual({ x: 0.5, y: 0.25 });
  });

  it('applies the camera when going to stage space', () => {
    const camera = { x: 100, y: 50, scale: 2 };
    expect(projectToStage({ x: 10, y: 20 }, camera)).toEqual({ x: 120, y: 90 });
  });

  it('round-trips normalized -> stage -> normalized at any camera', () => {
    const camera = { x: -237.5, y: 88.25, scale: 0.63 };
    const original = { x: 0.317, y: 0.842 };
    const roundTripped = stageToNormalized(
      normalizedToStage(original, settings, camera),
      settings,
      camera,
    );
    expect(roundTripped.x).toBeCloseTo(original.x, 10);
    expect(roundTripped.y).toBeCloseTo(original.y, 10);
  });

  it('round-trips stage -> project -> stage', () => {
    const camera = { x: 12, y: -40, scale: 3.5 };
    const point = { x: 431, y: 77 };
    const result = projectToStage(stageToProject(point, camera), camera);
    expect(result.x).toBeCloseTo(point.x, 10);
    expect(result.y).toBeCloseTo(point.y, 10);
  });

  it('clamps normalized values', () => {
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(3)).toBe(1);
    expect(isInsideNormalizedBounds({ x: 1.01, y: 0.5 })).toBe(false);
    expect(isInsideNormalizedBounds({ x: 1, y: 0 })).toBe(true);
  });
});

describe('camera', () => {
  it('fits the project centred inside the viewport', () => {
    const camera = fitCamera(settings, { width: 1400, height: 900 }, 50);
    const topLeft = projectToStage({ x: 0, y: 0 }, camera);
    const bottomRight = projectToStage({ x: settings.width, y: settings.height }, camera);
    // Symmetric margins on both axes.
    expect(topLeft.x).toBeCloseTo(1400 - bottomRight.x, 6);
    expect(topLeft.y).toBeCloseTo(900 - bottomRight.y, 6);
    expect(bottomRight.x - topLeft.x).toBeLessThanOrEqual(1400 - 100 + 0.001);
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    const camera = { x: 30, y: 60, scale: 1 };
    const pointer = { x: 400, y: 300 };
    const before = stageToProject(pointer, camera);
    const zoomed = zoomAtPoint(camera, pointer, 1.8);
    const after = stageToProject(pointer, zoomed);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
    expect(zoomed.scale).toBeCloseTo(1.8, 8);
  });

  it('respects zoom limits', () => {
    const camera = { x: 0, y: 0, scale: 1 };
    expect(zoomAtPoint(camera, { x: 0, y: 0 }, 1000).scale).toBeLessThanOrEqual(40);
    expect(zoomAtPoint(camera, { x: 0, y: 0 }, 0.0001).scale).toBeGreaterThanOrEqual(0.05);
  });
});

describe('geometry', () => {
  it('builds positive rects from any two corners', () => {
    expect(rectFromPoints({ x: 100, y: 80 }, { x: 20, y: 10 })).toEqual({
      x: 20,
      y: 10,
      width: 80,
      height: 70,
    });
  });

  it('tests rectangle containment', () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectContainsPoint(rect, { x: 5, y: 5 })).toBe(true);
    expect(rectContainsPoint(rect, { x: 11, y: 5 })).toBe(false);
  });

  it('tests point-in-polygon for a convex lasso', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon(square, { x: 5, y: 5 })).toBe(true);
    expect(pointInPolygon(square, { x: 15, y: 5 })).toBe(false);
    expect(pointInPolygon(square, { x: -0.5, y: 5 })).toBe(false);
  });

  it('tests point-in-polygon for a concave lasso', () => {
    // A "C" shape: the notch on the right must read as outside.
    const concave = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 3 },
      { x: 4, y: 3 },
      { x: 4, y: 7 },
      { x: 10, y: 7 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon(concave, { x: 2, y: 5 })).toBe(true);
    expect(pointInPolygon(concave, { x: 7, y: 5 })).toBe(false);
    expect(pointInPolygon(concave, { x: 7, y: 1 })).toBe(true);
  });

  it('rejects degenerate polygons', () => {
    expect(
      pointInPolygon(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        { x: 0.5, y: 0.5 },
      ),
    ).toBe(false);
  });
});
