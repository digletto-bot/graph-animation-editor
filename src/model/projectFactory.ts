import type {
  AnimationProject,
  GraphEdge,
  NodePosition,
  Pose,
  ProjectSettings,
  ReferenceDisplay,
} from './types.ts';
import { createId, createSeed } from '../utils/ids.ts';

export const DEFAULT_EDGE_WIDTH = 2.4;
export const DEFAULT_EDGE_BRIGHTNESS = 1;

export function createDefaultSettings(): ProjectSettings {
  return {
    width: 1200,
    height: 800,
    duration: 4,
    loop: true,
    lineColor: '#f6efe2',
    glowColor: '#ffd9a0',
    backgroundColor: '#05060a',
    showPreviewNodes: false,
  };
}

export function createDefaultReference(): ReferenceDisplay {
  return { visible: true, opacity: 0.4, locked: true, x: 0, y: 0, scale: 1 };
}

export function createPose(name: string, time: number, positions: Record<string, NodePosition> = {}): Pose {
  return { id: createId('pose'), name, time, positions: clonePositions(positions) };
}

export function createEmptyProject(): AnimationProject {
  return {
    version: 1,
    nodes: [],
    edges: [],
    poses: [createPose('Pose 1', 0)],
    settings: createDefaultSettings(),
    reference: createDefaultReference(),
  };
}

export function cloneProject(project: AnimationProject): AnimationProject {
  return {
    version: 1,
    nodes: project.nodes.map((node) => ({ ...node })),
    edges: project.edges.map((edge) => ({ ...edge })),
    poses: project.poses.map((pose) => ({
      ...pose,
      positions: clonePositions(pose.positions),
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
): string {
  const id = createId('node');
  const nodeName = name ?? `Node ${project.nodes.length + 1}`;
  project.nodes.push({ id, name: nodeName });
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
