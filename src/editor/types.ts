import type Konva from 'konva';
import type { NodePosition, Point, SelectableRef, ToolId } from '../model/types.ts';
import type { EditorStore } from '../state/EditorStore.ts';

export interface PointerInfo {
  /** Stage/screen CSS pixels. */
  screen: Point;
  /** Normalized project coordinates. */
  normalized: Point;
  target: SelectableRef | null;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  button: number;
}

export interface SnapResult {
  position: NodePosition;
  /** Screen position of the snap target, for the indicator. */
  indicator: Point | null;
  targetNodeId: string | null;
}

/**
 * The surface tools are allowed to touch. Tools never own geometry — they read
 * the store, mutate the store, and ask the editor to re-sync Konva.
 */
export interface EditorContext {
  store: EditorStore;
  stage: Konva.Stage;
  overlay: Konva.Layer;
  /** Rendered positions (active pose, or interpolated during playback). */
  displayPositions(): Record<string, NodePosition>;
  screenToNormalized(point: Point): Point;
  normalizedToScreen(point: NodePosition): Point;
  snap(position: NodePosition, excludeNodeIds: string[], bypass: boolean): SnapResult;
  showSnapIndicator(point: Point | null): void;
  syncPositions(): void;
  refreshOverlay(): void;
  nodeAtScreenPoint(point: Point): string | null;
  setCursor(cursor: string): void;
}

export interface Tool {
  readonly id: ToolId;
  activate?(): void;
  deactivate?(): void;
  onPointerDown?(info: PointerInfo): void;
  onPointerMove?(info: PointerInfo): void;
  onPointerUp?(info: PointerInfo): void;
  /** Return true when the tool consumed the Escape key. */
  onEscape?(): boolean;
}
