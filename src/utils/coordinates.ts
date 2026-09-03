import type { CameraState, Point, ProjectSettings, Size } from '../model/types.ts';

/**
 * Three coordinate spaces are in play:
 *
 *  1. Normalized  — 0..1 over the artwork area. This is what gets stored.
 *  2. Project     — logical project pixels (settings.width x settings.height).
 *  3. Stage       — Konva stage / screen CSS pixels, after camera pan + zoom.
 *
 * Camera maps project -> stage as `stage = project * scale + offset`.
 */

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 40;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function clampNormalized(point: Point): Point {
  return { x: clamp01(point.x), y: clamp01(point.y) };
}

export function isInsideNormalizedBounds(point: Point): boolean {
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}

export function normalizedToProject(point: Point, settings: ProjectSettings): Point {
  return { x: point.x * settings.width, y: point.y * settings.height };
}

export function projectToNormalized(point: Point, settings: ProjectSettings): Point {
  return { x: point.x / settings.width, y: point.y / settings.height };
}

export function projectToStage(point: Point, camera: CameraState): Point {
  return { x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y };
}

export function stageToProject(point: Point, camera: CameraState): Point {
  return { x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale };
}

export function normalizedToStage(
  point: Point,
  settings: ProjectSettings,
  camera: CameraState,
): Point {
  return projectToStage(normalizedToProject(point, settings), camera);
}

export function stageToNormalized(
  point: Point,
  settings: ProjectSettings,
  camera: CameraState,
): Point {
  return projectToNormalized(stageToProject(point, camera), settings);
}

/** Screen distance -> normalized distance, so snap radii feel identical at any zoom. */
export function screenDistanceToNormalized(
  distance: number,
  settings: ProjectSettings,
  camera: CameraState,
): { x: number; y: number } {
  return {
    x: distance / (camera.scale * settings.width),
    y: distance / (camera.scale * settings.height),
  };
}

/** Camera that centres the whole artwork area inside the viewport. */
export function fitCamera(
  settings: ProjectSettings,
  viewport: Size,
  padding = 48,
): CameraState {
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const scale = clamp(
    Math.min(availableWidth / settings.width, availableHeight / settings.height),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  return {
    scale,
    x: (viewport.width - settings.width * scale) / 2,
    y: (viewport.height - settings.height * scale) / 2,
  };
}

/**
 * Zoom so that the project point currently under `pointer` stays under it.
 * Pure — panning/zooming never touches stored node positions.
 */
export function zoomAtPoint(
  camera: CameraState,
  pointer: Point,
  factor: number,
  minZoom = MIN_ZOOM,
  maxZoom = MAX_ZOOM,
): CameraState {
  const scale = clamp(camera.scale * factor, minZoom, maxZoom);
  if (scale === camera.scale) return { ...camera };
  const world = stageToProject(pointer, camera);
  return {
    scale,
    x: pointer.x - world.x * scale,
    y: pointer.y - world.y * scale,
  };
}

export function panCamera(camera: CameraState, dx: number, dy: number): CameraState {
  return { scale: camera.scale, x: camera.x + dx, y: camera.y + dy };
}
