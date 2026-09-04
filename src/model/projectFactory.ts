import type {
  AnimationProject,
  GraphEdge,
  GraphPart,
  NodePosition,
  OccluderPath,
  Pose,
  Size,
} from './types.ts';
import { createId, createSeed } from '../utils/ids.ts';
import {
  DEFAULT_EDGE_BRIGHTNESS,
  DEFAULT_EDGE_WIDTH,
  DEFAULT_NODE_BRIGHTNESS,
  DEFAULT_NODE_WIDTH,
  DEFAULT_PROJECT_NAME,
  createDefaultParts,
  createDefaultReference,
  createDefaultSettings,
} from '../runtime/defaults.ts';
import {
  BODY_PART_ID,
  DEFAULT_PART_ID,
  FAR_WING_PART_ID,
  isLastPart,
  sortPartsByZ,
} from '../runtime/parts.ts';
import { DEFAULT_MASK_EXPANSION } from '../runtime/occluders.ts';

export {
  DEFAULT_EDGE_BRIGHTNESS,
  DEFAULT_EDGE_WIDTH,
  DEFAULT_NODE_BRIGHTNESS,
  DEFAULT_NODE_WIDTH,
  DEFAULT_PROJECT_NAME,
  createDefaultParts,
  createDefaultReference,
  createDefaultSettings,
} from '../runtime/defaults.ts';

export function createPose(name: string, time: number, positions: Record<string, NodePosition> = {}): Pose {
  return { id: createId('pose'), name, time, positions: clonePositions(positions) };
}

export function createEmptyProject(): AnimationProject {
  return {
    version: 3,
    name: DEFAULT_PROJECT_NAME,
    parts: createDefaultParts(),
    nodes: [],
    edges: [],
    poses: [createPose('Pose 1', 0)],
    occluders: [],
    settings: createDefaultSettings(),
    reference: createDefaultReference(),
  };
}

export function cloneProject(project: AnimationProject): AnimationProject {
  return {
    version: 3,
    name: project.name,
    parts: project.parts.map((part) => ({ ...part })),
    nodes: project.nodes.map((node) => ({ ...node })),
    edges: project.edges.map((edge) => ({ ...edge })),
    poses: project.poses.map((pose) => ({
      ...pose,
      positions: clonePositions(pose.positions),
    })),
    occluders: project.occluders.map((occluder) => ({
      ...occluder,
      boundaryNodeIds: [...occluder.boundaryNodeIds],
      targetPartIds: [...occluder.targetPartIds],
    })),
    settings: { ...project.settings },
    reference: project.reference ? { ...project.reference } : createDefaultReference(),
  };
}

export function clonePositions(
  positions: Record<string, NodePosition>,
): Record<string, NodePosition> {
  const result: Record<string, NodePosition> = {};
  for (const key of Object.keys(positions)) {
    const value = positions[key]!;
    result[key] = { x: value.x, y: value.y };
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Graph operations. All mutate the given project in place; the store   */
/* snapshots for history *before* calling them.                         */
/* ------------------------------------------------------------------ */

/**
 * Adds a node to the global collection and gives every pose a position for it.
 * The active pose gets the clicked point; other poses start at the same place
 * so the node does not fly in from nowhere.
 */
export function addNode(
  project: AnimationProject,
  position: NodePosition,
  activePoseId: string,
  name?: string,
  partId: string = defaultPartId(project),
): string {
  const id = createId('node');
  const nodeName = name ?? `Node ${project.nodes.length + 1}`;
  project.nodes.push({
    id,
    name: nodeName,
    partId: resolvePartId(project, partId),
    width: DEFAULT_NODE_WIDTH,
    brightness: DEFAULT_NODE_BRIGHTNESS,
  });
  for (const pose of project.poses) {
    pose.positions[id] = { x: position.x, y: position.y };
  }
  // Explicitly reassert the active pose (identical today, but keeps intent
  // clear if per-pose defaults ever diverge).
  const activePose = project.poses.find((pose) => pose.id === activePoseId);
  if (activePose) activePose.positions[id] = { x: position.x, y: position.y };
  return id;
}

/** Removes nodes, their pose entries, and every edge touching them. */
export function deleteNodes(project: AnimationProject, nodeIds: string[]): void {
  if (nodeIds.length === 0) return;
  const doomed = new Set(nodeIds);
  project.nodes = project.nodes.filter((node) => !doomed.has(node.id));
  project.edges = project.edges.filter(
    (edge) => !doomed.has(edge.from) && !doomed.has(edge.to),
  );
  for (const pose of project.poses) {
    for (const id of doomed) delete pose.positions[id];
  }
  // An occluder never owns its vertices: drop the dead references and let the
  // polygon shrink. Occluders that fall below three nodes stay in the project
  // and are reported by validation rather than silently deleted.
  for (const occluder of project.occluders) {
    occluder.boundaryNodeIds = occluder.boundaryNodeIds.filter((id) => !doomed.has(id));
  }
}

export function deleteEdges(project: AnimationProject, edgeIds: string[]): void {
  if (edgeIds.length === 0) return;
  const doomed = new Set(edgeIds);
  project.edges = project.edges.filter((edge) => !doomed.has(edge.id));
}

export function findEdgeBetween(
  project: AnimationProject,
  a: string,
  b: string,
): GraphEdge | undefined {
  return project.edges.find(
    (edge) =>
      (edge.from === a && edge.to === b) || (edge.from === b && edge.to === a),
  );
}

/**
 * Creates an edge, rejecting self-edges and duplicates (in either direction).
 * Returns the new edge id, or null when the edge was rejected.
 */
export function addEdge(
  project: AnimationProject,
  from: string,
  to: string,
  overrides: Partial<Omit<GraphEdge, 'id' | 'from' | 'to'>> = {},
  partId: string = defaultPartId(project),
): string | null {
  if (from === to) return null;
  const hasNodes =
    project.nodes.some((node) => node.id === from) &&
    project.nodes.some((node) => node.id === to);
  if (!hasNodes) return null;
  if (findEdgeBetween(project, from, to)) return null;
  const edge: GraphEdge = {
    id: createId('edge'),
    from,
    to,
    partId: resolvePartId(project, overrides.partId ?? partId),
    width: overrides.width ?? DEFAULT_EDGE_WIDTH,
    brightness: overrides.brightness ?? DEFAULT_EDGE_BRIGHTNESS,
    seed: overrides.seed ?? createSeed(),
  };
  project.edges.push(edge);
  return edge.id;
}

export function edgesForNode(project: AnimationProject, nodeId: string): GraphEdge[] {
  return project.edges.filter((edge) => edge.from === nodeId || edge.to === nodeId);
}

/* ------------------------------- poses ---------------------------- */

export function getPose(project: AnimationProject, poseId: string): Pose | undefined {
  return project.poses.find((pose) => pose.id === poseId);
}

/** Keeps pose times ascending and inside the project duration. */
export function normalizePoseTimes(project: AnimationProject): void {
  const duration = Math.max(0.001, project.settings.duration);
  project.poses.sort((a, b) => a.time - b.time);
  let previous = -Infinity;
  for (const pose of project.poses) {
    let time = Math.min(Math.max(pose.time, 0), duration);
    if (time <= previous) time = Math.min(previous + 0.01, duration);
    pose.time = Number(time.toFixed(4));
    previous = pose.time;
  }
}

/**
 * Rescales pose times into a changed duration, preserving relative spacing.
 *
 * Clamping alone (what `normalizePoseTimes` does on its own) piles every pose
 * past the new end onto the last instant, which silently destroys the tail of
 * an animation. Scaling keeps the timing the animator authored: evenly spaced
 * poses stay evenly spaced, and deliberate uneven spacing survives too.
 */
export function rescalePoseTimes(project: AnimationProject, previousDuration: number): void {
  const duration = Math.max(0.001, project.settings.duration);
  const previous = Math.max(0.001, previousDuration);
  if (previous !== duration) {
    const factor = duration / previous;
    for (const pose of project.poses) {
      pose.time = Number((pose.time * factor).toFixed(4));
    }
  }
  normalizePoseTimes(project);
}

/* ------------------------- artwork geometry ------------------------- */

/**
 * Applies `transform` to every stored position in every pose.
 *
 * Positions are normalized to the artwork area, so anything that changes the
 * area itself has to move the artwork with it; a pose-by-pose edit would leave
 * the animation inconsistent between frames.
 */
function transformAllPositions(
  project: AnimationProject,
  transform: (position: NodePosition) => NodePosition,
): void {
  for (const pose of project.poses) {
    for (const nodeId of Object.keys(pose.positions)) {
      const moved = transform(pose.positions[nodeId]!);
      pose.positions[nodeId] = { x: round4(moved.x), y: round4(moved.y) };
    }
  }
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * The uniform scale a resize applies to the artwork, in artwork pixels.
 *
 * A board that grew keeps the artwork at its original pixel size (scale 1) and
 * lets the new room show as margin. A board that shrank in either axis scales
 * the artwork down by the tighter of the two ratios, so nothing is pushed out
 * of frame.
 */
export function artworkRefitScale(previous: Size, next: Size): number {
  if (previous.width <= 0 || previous.height <= 0) return 1;
  return Math.min(1, next.width / previous.width, next.height / previous.height);
}

/**
 * Remaps every position so a resized artboard does not distort the artwork.
 *
 * Stored coordinates are fractions of the board, so shrinking the width alone
 * squashes the drawing horizontally. Compensating means undoing the change in
 * the board's own aspect ratio: the artwork keeps its proportions, sits at the
 * centre of the new board, and shrinks only when it would otherwise overflow.
 */
export function refitArtworkToSize(project: AnimationProject, previous: Size): void {
  const next = { width: project.settings.width, height: project.settings.height };
  if (previous.width <= 0 || previous.height <= 0) return;
  if (previous.width === next.width && previous.height === next.height) return;

  const scale = artworkRefitScale(previous, next);
  // Normalized space is stretched by the board's own change, so the pixel
  // scale has to be divided back out of each axis separately.
  const factorX = (scale * previous.width) / next.width;
  const factorY = (scale * previous.height) / next.height;
  transformAllPositions(project, (position) => ({
    x: 0.5 + (position.x - 0.5) * factorX,
    y: 0.5 + (position.y - 0.5) * factorY,
  }));
}

/**
 * Scales the whole animation about the centre of the artboard.
 *
 * Every pose moves by the same factor, so the animation is resized without
 * changing a single relationship inside it. Scaling up can push nodes past the
 * frame — they are kept rather than clamped, because clamping the ones that
 * overshoot would deform the artwork the scale was meant to preserve.
 */
export function scaleArtwork(project: AnimationProject, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return;
  transformAllPositions(project, (position) => ({
    x: 0.5 + (position.x - 0.5) * factor,
    y: 0.5 + (position.y - 0.5) * factor,
  }));
}

/** Redistributes pose times evenly across the duration, preserving order. */
export function redistributePoseTimes(project: AnimationProject): void {
  const count = project.poses.length;
  const duration = Math.max(0.001, project.settings.duration);
  if (count === 1) {
    project.poses[0]!.time = 0;
    return;
  }
  project.poses.forEach((pose, index) => {
    pose.time = Number(((index / (count - 1)) * duration).toFixed(4));
  });
}

/** Duplicates `sourcePoseId`'s positions into a new pose appended after it. */
export function addPose(
  project: AnimationProject,
  sourcePoseId: string,
  name?: string,
): Pose {
  const source = getPose(project, sourcePoseId) ?? project.poses[project.poses.length - 1]!;
  const sourceIndex = project.poses.indexOf(source);
  const pose = createPose(
    name ?? `Pose ${project.poses.length + 1}`,
    source.time,
    source.positions,
  );
  // Make sure every node has an entry, even if the source pose was stale.
  for (const node of project.nodes) {
    if (!pose.positions[node.id]) pose.positions[node.id] = { x: 0.5, y: 0.5 };
  }
  project.poses.splice(sourceIndex + 1, 0, pose);
  redistributePoseTimes(project);
  return pose;
}

export function deletePose(project: AnimationProject, poseId: string): boolean {
  if (project.poses.length <= 1) return false;
  const index = project.poses.findIndex((pose) => pose.id === poseId);
  if (index === -1) return false;
  project.poses.splice(index, 1);
  redistributePoseTimes(project);
  return true;
}

export function movePose(project: AnimationProject, poseId: string, offset: number): boolean {
  const index = project.poses.findIndex((pose) => pose.id === poseId);
  const target = index + offset;
  if (index === -1 || target < 0 || target >= project.poses.length) return false;
  const [pose] = project.poses.splice(index, 1);
  project.poses.splice(target, 0, pose!);
  redistributePoseTimes(project);
  return true;
}

/** Fills in any missing node positions — used after import for safety. */
export function ensurePosePositions(project: AnimationProject): void {
  for (const pose of project.poses) {
    for (const node of project.nodes) {
      if (!pose.positions[node.id]) pose.positions[node.id] = { x: 0.5, y: 0.5 };
    }
    for (const key of Object.keys(pose.positions)) {
      if (!project.nodes.some((node) => node.id === key)) delete pose.positions[key];
    }
  }
}

/* ------------------------------- parts ----------------------------- */

/**
 * The part new geometry lands on. Bird-era files keep pointing at the body;
 * everything else uses the backmost part, and never a dangling id.
 */
export function defaultPartId(project: AnimationProject): string {
  if (project.parts.some((part) => part.id === BODY_PART_ID)) return BODY_PART_ID;
  return project.parts[0]?.id ?? DEFAULT_PART_ID;
}

export function resolvePartId(project: AnimationProject, partId: string): string {
  return project.parts.some((part) => part.id === partId) ? partId : defaultPartId(project);
}

export function addPart(project: AnimationProject, name?: string): GraphPart {
  const highest = project.parts.reduce((max, part) => Math.max(max, part.zIndex), 0);
  const part: GraphPart = {
    id: createId('part'),
    name: name ?? `Part ${project.parts.length + 1}`,
    role: 'other',
    zIndex: highest + 10,
    renderEnabled: true,
  };
  project.parts.push(part);
  return part;
}

export interface PartContents {
  nodeIds: string[];
  edgeIds: string[];
  occluderIds: string[];
}

/** Everything that would be orphaned if `partId` disappeared. */
export function partContents(project: AnimationProject, partId: string): PartContents {
  return {
    nodeIds: project.nodes.filter((node) => node.partId === partId).map((node) => node.id),
    edgeIds: project.edges.filter((edge) => edge.partId === partId).map((edge) => edge.id),
    occluderIds: project.occluders
      .filter(
        (occluder) => occluder.ownerPartId === partId || occluder.targetPartIds.includes(partId),
      )
      .map((occluder) => occluder.id),
  };
}

export function isPartEmpty(project: AnimationProject, partId: string): boolean {
  const contents = partContents(project, partId);
  return (
    contents.nodeIds.length === 0 &&
    contents.edgeIds.length === 0 &&
    contents.occluderIds.length === 0
  );
}

/** Moves every node, edge and occluder reference from one part to another. */
export function reassignPartContents(
  project: AnimationProject,
  fromPartId: string,
  toPartId: string,
): void {
  const target = resolvePartId(project, toPartId);
  for (const node of project.nodes) {
    if (node.partId === fromPartId) node.partId = target;
  }
  for (const edge of project.edges) {
    if (edge.partId === fromPartId) edge.partId = target;
  }
  for (const occluder of project.occluders) {
    if (occluder.ownerPartId === fromPartId) occluder.ownerPartId = target;
    if (occluder.targetPartIds.includes(fromPartId)) {
      const remapped = occluder.targetPartIds.map((id) => (id === fromPartId ? target : id));
      occluder.targetPartIds = [...new Set(remapped)];
    }
  }
}

export type DeletePartResult =
  | { ok: true }
  | { ok: false; reason: 'last-part' | 'missing' | 'not-empty'; contents?: PartContents };

/**
 * Deleting never destroys geometry. A part with contents is refused unless the
 * caller names an explicit `reassignTo` part, and the last remaining part is
 * refused outright — geometry would have nowhere to go.
 */
export function deletePart(
  project: AnimationProject,
  partId: string,
  reassignTo?: string,
): DeletePartResult {
  if (isLastPart(project, partId)) return { ok: false, reason: 'last-part' };
  if (!project.parts.some((part) => part.id === partId)) return { ok: false, reason: 'missing' };

  const contents = partContents(project, partId);
  const hasContents =
    contents.nodeIds.length > 0 || contents.edgeIds.length > 0 || contents.occluderIds.length > 0;
  if (hasContents) {
    if (!reassignTo || reassignTo === partId) return { ok: false, reason: 'not-empty', contents };
    reassignPartContents(project, partId, reassignTo);
  }
  project.parts = project.parts.filter((part) => part.id !== partId);
  return { ok: true };
}

/** Reorders by rewriting zIndex from the sorted order; keeps values compact. */
export function movePartOrder(project: AnimationProject, partId: string, offset: number): boolean {
  const ordered = sortPartsByZ(project.parts);
  const index = ordered.findIndex((part) => part.id === partId);
  const target = index + offset;
  if (index === -1 || target < 0 || target >= ordered.length) return false;
  const [moved] = ordered.splice(index, 1);
  ordered.splice(target, 0, moved!);
  ordered.forEach((part, position) => {
    part.zIndex = position * 10;
  });
  return true;
}

/** Edges with *both* endpoints inside `nodeIds` — an edge internal to that set. */
export function edgesInsideNodeSet(project: AnimationProject, nodeIds: string[]): string[] {
  const inside = new Set(nodeIds);
  return project.edges
    .filter((edge) => inside.has(edge.from) && inside.has(edge.to))
    .map((edge) => edge.id);
}

/**
 * Moves nodes to a part, and by default takes their internal edges along.
 *
 * Only edges whose *both* endpoints are moving follow: an edge that spans two
 * parts has no obvious home, so it keeps the part it already had. Without this
 * a wing moved out of the body would leave its whole mesh of edges behind,
 * still drawn on the old layer with no visible endpoints.
 */
export function assignNodesToPart(
  project: AnimationProject,
  nodeIds: string[],
  partId: string,
  moveInternalEdges = true,
): void {
  const target = resolvePartId(project, partId);
  const wanted = new Set(nodeIds);
  for (const node of project.nodes) {
    if (wanted.has(node.id)) node.partId = target;
  }
  if (!moveInternalEdges) return;
  const internal = new Set(edgesInsideNodeSet(project, nodeIds));
  for (const edge of project.edges) {
    if (internal.has(edge.id)) edge.partId = target;
  }
}

export function assignEdgesToPart(
  project: AnimationProject,
  edgeIds: string[],
  partId: string,
): void {
  const target = resolvePartId(project, partId);
  const wanted = new Set(edgeIds);
  for (const edge of project.edges) {
    if (wanted.has(edge.id)) edge.partId = target;
  }
}

/* ----------------------------- occluders --------------------------- */

export function createOccluder(
  project: AnimationProject,
  boundaryNodeIds: string[],
  options: {
    name?: string;
    ownerPartId?: string;
    targetPartIds?: string[];
    maskExpansion?: number;
  } = {},
): OccluderPath {
  const owner = resolvePartId(project, options.ownerPartId ?? defaultPartId(project));
  const occluder: OccluderPath = {
    id: createId('occ'),
    name: options.name ?? `Occluder ${project.occluders.length + 1}`,
    ownerPartId: owner,
    boundaryNodeIds: [...new Set(boundaryNodeIds)],
    targetPartIds: [
      ...new Set(
        (options.targetPartIds ?? [FAR_WING_PART_ID]).filter((id) =>
          project.parts.some((part) => part.id === id),
        ),
      ),
    ],
    enabled: true,
    maskExpansion: options.maskExpansion ?? DEFAULT_MASK_EXPANSION,
  };
  project.occluders.push(occluder);
  return occluder;
}

export function getOccluder(
  project: AnimationProject,
  occluderId: string,
): OccluderPath | undefined {
  return project.occluders.find((occluder) => occluder.id === occluderId);
}

export function deleteOccluder(project: AnimationProject, occluderId: string): boolean {
  const before = project.occluders.length;
  project.occluders = project.occluders.filter((occluder) => occluder.id !== occluderId);
  return project.occluders.length !== before;
}

