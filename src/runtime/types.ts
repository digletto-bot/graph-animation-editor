/**
 * The animation document, and nothing else.
 *
 * These types are the file format: everything an embedded player needs to draw
 * a project, with no editor concept anywhere in them. `model/types.ts`
 * re-exports the lot, so editor code can keep importing from one place.
 *
 * The artwork is a graph of shared nodes joined by edges. Topology (nodes +
 * edges) is global; only *positions* vary per pose. All stored positions are
 * normalized to the 0..1 project artwork area, so an animation is resolution
 * independent and can be replayed at any canvas size.
 */

/**
 * Layer roles. A new project's parts are all "other"; the three named roles
 * survive so bird-era files keep their layer colours and occluder defaults.
 */
export type PartRole = 'far-wing' | 'body' | 'near-wing' | 'other';

/**
 * A render layer. Parts own nodes and edges by id reference; geometry is never
 * nested under a part, so a node keeps its identity when it changes layer.
 */
export interface GraphPart {
  id: string;
  name: string;
  role: PartRole;
  /** Static back-to-front order. Low draws first (behind). */
  zIndex: number;
  /** Runtime visibility in Preview/production. Editor hide/solo is separate. */
  renderEnabled: boolean;
}

export interface GraphNode {
  id: string;
  name: string;
  /** Owning part id. Every node has exactly one. */
  partId: string;
  /** Dot radius in logical project pixels, when preview nodes are shown. */
  width: number;
  /** 0..2 multiplier applied to the dot's opacity in preview. */
  brightness: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /**
   * Owning part id, which decides the render layer. An edge may join nodes
   * from two different parts; its own partId still wins.
   */
  partId: string;
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

/** How positions are blended between authored poses. */
export type InterpolationMode = 'linear' | 'catmull-rom';

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
  /**
   * Whether the background is painted at all. Distinct from a transparent
   * colour: this survives as an authoring choice, so the colour is still there
   * to switch back on, and it is what an embedding page overrides.
   */
  backgroundEnabled: boolean;
  showPreviewNodes: boolean;
  /** Position blending between poses. */
  interpolation: InterpolationMode;
  /** 0..1 smoothing for "catmull-rom". 0 collapses to linear-like tangents. */
  tension: number;
}

/**
 * A closed masking polygon whose vertices are *references* to graph nodes, so
 * it follows every pose and every interpolated frame without ever storing its
 * own copy of a position. Occluders are never drawn; they only erase.
 */
export interface OccluderPath {
  id: string;
  name: string;
  /** The part that owns the silhouette (typically body or near wing). */
  ownerPartId: string;
  /** Node ids in polygon order. Closes automatically from last back to first. */
  boundaryNodeIds: string[];
  /** Parts erased by this mask. */
  targetPartIds: string[];
  enabled: boolean;
  /** Outward mask growth in project pixels; hides glow bleed at the silhouette. */
  maskExpansion: number;
}

/**
 * Reference image placement + display settings. The image *data* is never part
 * of this — only how it is laid out over the artwork area.
 */
export interface ReferenceDisplay {
  visible: boolean;
  /** 0..1 */
  opacity: number;
  /** Top-left offset in logical project pixels. */
  x: number;
  y: number;
  /** Uniform scale applied to the image's natural size. */
  scale: number;
}

export interface AnimationProject {
  version: 3;
  /** Author-facing document name. Drives the export filename. */
  name: string;
  /** Render layers, back to front by zIndex. */
  parts: GraphPart[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  poses: Pose[];
  occluders: OccluderPath[];
  settings: ProjectSettings;
  /** Optional: transform/display only, never image bytes. */
  reference?: ReferenceDisplay;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}
