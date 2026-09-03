/**
 * Core data model.
 *
 * The artwork is a graph of shared nodes joined by edges. Topology (nodes +
 * edges) is global; only *positions* vary per pose. All stored positions are
 * normalized to the 0..1 project artwork area so the animation is resolution
 * independent and can be replayed at any canvas size without Konva.
 */

export interface GraphNode {
  id: string;
  name: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** Stroke width in logical project pixels. */
  width: number;
  /** 0..2 multiplier applied to the glow/core passes in preview. */
  brightness: number;
  /** Stable per-edge random seed, used for subtle brightness variation. */
  seed: number;
}

export interface NodePosition {
  x: number;
  y: number;
}

export interface Pose {
  id: string;
  name: string;
  /** Seconds from the start of the animation. */
  time: number;
  /** Normalized position for every node id in the project. */
  positions: Record<string, NodePosition>;
}

export interface ProjectSettings {
  /** Logical project pixel width of the artwork area. */
  width: number;
  height: number;
  /** Total animation length in seconds. */
  duration: number;
  loop: boolean;
  lineColor: string;
  glowColor: string;
  backgroundColor: string;
  showPreviewNodes: boolean;
}

/**
 * Reference image placement + display settings. The image *data* is never part
 * of this — only how it is laid out over the artwork area.
 */
export interface ReferenceDisplay {
  visible: boolean;
  /** 0..1 */
  opacity: number;
  locked: boolean;
  /** Top-left offset in logical project pixels. */
  x: number;
  y: number;
  /** Uniform scale applied to the image's natural size. */
  scale: number;
}

export interface AnimationProject {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
  poses: Pose[];
  settings: ProjectSettings;
  /** Optional: transform/display only, never image bytes. */
  reference?: ReferenceDisplay;
}

export type EditorMode = 'edit' | 'preview';

export type ToolId = 'select' | 'node' | 'edge' | 'lasso' | 'pan';

export interface CameraState {
  /** Screen-space offset of the project origin, in CSS pixels. */
  x: number;
  y: number;
  /** Project pixels -> screen pixels. */
  scale: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type SelectableKind = 'node' | 'edge';

export interface SelectableRef {
  kind: SelectableKind;
  id: string;
}

export interface OnionSettings {
  showPrevious: boolean;
  showNext: boolean;
  opacity: number;
  showNodes: boolean;
}

export interface SnapSettings {
  enabled: boolean;
  toNodes: boolean;
  toGrid: boolean;
  /** Screen-space radius in CSS pixels. */
  threshold: number;
  /** Grid step in logical project pixels. */
  gridSize: number;
}

export interface GridSettings {
  visible: boolean;
}

/**
 * Editor preferences persisted independently of the project file — view/tool
 * behavior and default colors for the next new project, not artwork data.
 */
export interface EditorPreferences {
  colors: Pick<ProjectSettings, 'lineColor' | 'glowColor' | 'backgroundColor' | 'showPreviewNodes'>;
  reference: Pick<ReferenceDisplay, 'visible' | 'locked' | 'opacity' | 'scale'>;
  onion: OnionSettings;
  snapping: SnapSettings;
  grid: GridSettings;
}
