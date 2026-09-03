import type { AnimationProject, GraphEdge, GraphNode, Pose, ProjectSettings } from './types.ts';
import { createDefaultReference, createDefaultSettings } from './projectFactory.ts';

export const SCHEMA_VERSION = 1;

export type ValidationResult =
  | { ok: true; project: AnimationProject; warnings: string[] }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validates untrusted JSON before it is allowed to replace the live project.
 * Returns human-readable errors rather than throwing, so the UI can show them.
 */
export function validateProject(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(input)) {
    return { ok: false, errors: ['File is not a JSON object.'] };
  }
  if (input.version !== SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [`Unsupported schema version ${String(input.version)}. Expected ${SCHEMA_VERSION}.`],
    };
  }
  if (!Array.isArray(input.nodes)) errors.push('"nodes" must be an array.');
  if (!Array.isArray(input.edges)) errors.push('"edges" must be an array.');
  if (!Array.isArray(input.poses)) errors.push('"poses" must be an array.');
  if (!isRecord(input.settings)) errors.push('"settings" must be an object.');
  if (errors.length > 0) return { ok: false, errors };

  const rawNodes = input.nodes as unknown[];
  const rawEdges = input.edges as unknown[];
  const rawPoses = input.poses as unknown[];

  const nodes: GraphNode[] = [];
  const nodeIds = new Set<string>();
  rawNodes.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) {
      errors.push(`Node ${index} is missing a string "id".`);
      return;
    }
    if (nodeIds.has(raw.id)) {
      errors.push(`Duplicate node id "${raw.id}".`);
      return;
    }
    nodeIds.add(raw.id);
    nodes.push({
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : `Node ${index + 1}`,
    });
  });

  const edges: GraphEdge[] = [];
  const edgeIds = new Set<string>();
  const edgePairs = new Set<string>();
  rawEdges.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.id !== 'string') {
      errors.push(`Edge ${index} is missing a string "id".`);
      return;
    }
    if (typeof raw.from !== 'string' || typeof raw.to !== 'string') {
      errors.push(`Edge "${raw.id}" must reference "from" and "to" node ids.`);
      return;
    }
    if (edgeIds.has(raw.id)) {
      errors.push(`Duplicate edge id "${raw.id}".`);
      return;
    }
    if (!nodeIds.has(raw.from) || !nodeIds.has(raw.to)) {
      errors.push(`Edge "${raw.id}" references a node that does not exist.`);
      return;
    }
    if (raw.from === raw.to) {
      errors.push(`Edge "${raw.id}" connects a node to itself.`);
      return;
    }
    const pair = [raw.from, raw.to].sort().join('::');
    if (edgePairs.has(pair)) {
      warnings.push(`Duplicate edge between the same two nodes was dropped ("${raw.id}").`);
      return;
    }
    edgePairs.add(pair);
    edgeIds.add(raw.id);
    edges.push({
      id: raw.id,
      from: raw.from,
      to: raw.to,
      width: isFiniteNumber(raw.width) ? raw.width : 2.4,
      brightness: isFiniteNumber(raw.brightness) ? raw.brightness : 1,
      seed: isFiniteNumber(raw.seed) ? raw.seed : 0,
    });
  });

  const poses: Pose[] = [];
  const poseIds = new Set<string>();
  if (rawPoses.length === 0) errors.push('A project needs at least one pose.');
  rawPoses.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.id !== 'string') {
      errors.push(`Pose ${index} is missing a string "id".`);
      return;
    }
    if (poseIds.has(raw.id)) {
      errors.push(`Duplicate pose id "${raw.id}".`);
      return;
    }
    if (!isFiniteNumber(raw.time)) {
      errors.push(`Pose "${raw.id}" has an invalid "time".`);
      return;
    }
    if (!isRecord(raw.positions)) {
      errors.push(`Pose "${raw.id}" is missing a "positions" map.`);
      return;
    }
    poseIds.add(raw.id);
    const positions: Pose['positions'] = {};
    for (const nodeId of nodeIds) {
      const value = raw.positions[nodeId];
      if (isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y)) {
        positions[nodeId] = { x: value.x, y: value.y };
      } else {
        warnings.push(`Pose "${raw.id}" was missing a position for node "${nodeId}".`);
        positions[nodeId] = { x: 0.5, y: 0.5 };
      }
    }
    poses.push({
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : `Pose ${index + 1}`,
      time: raw.time,
      positions,
    });
  });

  if (errors.length > 0) return { ok: false, errors };

  const rawSettings = input.settings as Record<string, unknown>;
  const defaults = createDefaultSettings();
  const settings: ProjectSettings = {
    width: isFiniteNumber(rawSettings.width) && rawSettings.width > 0 ? rawSettings.width : defaults.width,
    height:
      isFiniteNumber(rawSettings.height) && rawSettings.height > 0 ? rawSettings.height : defaults.height,
    duration:
      isFiniteNumber(rawSettings.duration) && rawSettings.duration > 0
        ? rawSettings.duration
        : defaults.duration,
    loop: typeof rawSettings.loop === 'boolean' ? rawSettings.loop : defaults.loop,
    lineColor: typeof rawSettings.lineColor === 'string' ? rawSettings.lineColor : defaults.lineColor,
    glowColor: typeof rawSettings.glowColor === 'string' ? rawSettings.glowColor : defaults.glowColor,
    backgroundColor:
      typeof rawSettings.backgroundColor === 'string'
        ? rawSettings.backgroundColor
        : defaults.backgroundColor,
    showPreviewNodes:
      typeof rawSettings.showPreviewNodes === 'boolean'
        ? rawSettings.showPreviewNodes
        : defaults.showPreviewNodes,
  };

  const reference = createDefaultReference();
  if (isRecord(input.reference)) {
    const raw = input.reference;
    if (typeof raw.visible === 'boolean') reference.visible = raw.visible;
    if (isFiniteNumber(raw.opacity)) reference.opacity = Math.min(1, Math.max(0, raw.opacity));
    if (typeof raw.locked === 'boolean') reference.locked = raw.locked;
    if (isFiniteNumber(raw.x)) reference.x = raw.x;
    if (isFiniteNumber(raw.y)) reference.y = raw.y;
    if (isFiniteNumber(raw.scale) && raw.scale > 0) reference.scale = raw.scale;
  }

  poses.sort((a, b) => a.time - b.time);

  return {
    ok: true,
    warnings,
    project: { version: SCHEMA_VERSION, nodes, edges, poses, settings, reference },
  };
}
