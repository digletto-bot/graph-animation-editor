/**
 * Editor-side types: modes, tools, view state and preferences.
 *
 * The animation document itself lives in `runtime/types.ts` — it is the part an
 * embedded player ships — and is re-exported here so editor modules have a
 * single import for both.
 */

export type {
  AnimationProject,
  GraphEdge,
  GraphNode,
  GraphPart,
  InterpolationMode,
  NodePosition,
  OccluderPath,
  PartRole,
  Point,
  Pose,
  ProjectSettings,
  ReferenceDisplay,
  Size,
} from '../runtime/types.ts';

import type { ProjectSettings, ReferenceDisplay } from '../runtime/types.ts';

export type EditorMode = 'edit' | 'preview';

export type ToolId = 'select' | 'node' | 'edge' | 'lasso' | 'pan' | 'occluder' | 'reference';

export interface CameraState {
  /** Screen-space offset of the project origin, in CSS pixels. */
  x: number;
  y: number;
  /** Project pixels -> screen pixels. */
  scale: number;
}

export type SelectableKind = 'node' | 'edge';

/**
 * What the pointer is allowed to pick. "both" prefers nodes and falls back to
 * edges; the single-kind modes make dense artwork workable — edges hidden under
 * a cluster of nodes stay reachable, and node dragging never grabs an edge.
 */
export type SelectionMode = 'both' | 'nodes' | 'edges';

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
 * Editor-only per-part display state. Never exported with the animation and
 * never consulted by the Preview renderer.
 */
export interface PartDisplayState {
  locked: boolean;
  hidden: boolean;
  solo: boolean;
  xray: boolean;
}

/**
 * Editor preferences persisted independently of the project file — view/tool
 * behavior and default colors for the next new project, not artwork data.
 */
export interface EditorPreferences {
  colors: Pick<ProjectSettings, 'lineColor' | 'glowColor' | 'backgroundColor' | 'showPreviewNodes'>;
  reference: Pick<ReferenceDisplay, 'visible' | 'opacity' | 'scale'>;
  onion: OnionSettings;
  snapping: SnapSettings;
  grid: GridSettings;
  /** Editor-only part display state, keyed by part id. */
  partDisplay: Record<string, PartDisplayState>;
  /** Global occluder overlay toggle in Edit mode. */
  showOccluders: boolean;
  /** What the pointer picks: nodes, edges, or both. */
  selectionMode: SelectionMode;
  /** Whether resizing the artboard remaps the artwork instead of squashing it. */
  keepArtworkProportions: boolean;
}
