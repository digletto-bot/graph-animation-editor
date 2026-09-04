import type {
  AnimationProject,
  GraphEdge,
  GraphNode,
  GraphPart,
  InterpolationMode,
  OccluderPath,
  PartRole,
  Pose,
  ProjectSettings,
} from './types.ts';
import {
  DEFAULT_NODE_BRIGHTNESS,
  DEFAULT_NODE_WIDTH,
  DEFAULT_PROJECT_NAME,
  createDefaultParts,
  createDefaultReference,
  createDefaultSettings,
} from './defaults.ts';
import { BODY_PART_ID, sortPartsByZ } from './parts.ts';
import { DEFAULT_MASK_EXPANSION, MIN_BOUNDARY_NODES } from './occluders.ts';

/** Current on-disk schema. Version 1 files are migrated on import. */
export const SCHEMA_VERSION = 3;
/** Oldest schema this build can still read. */
export const MIN_SUPPORTED_VERSION = 1;

export type ValidationResult =
  | { ok: true; project: AnimationProject; warnings: string[] }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const PART_ROLES: PartRole[] = ['far-wing', 'body', 'near-wing', 'other'];

function isPartRole(value: unknown): value is PartRole {
  return typeof value === 'string' && (PART_ROLES as string[]).includes(value);
}

/**
 * Validates untrusted JSON before it is allowed to replace the live project,
 * or to be handed to a player on someone else's site.
 * Returns human-readable errors rather than throwing, so the UI can show them.
 *
 * Schema 1 files carry no parts and no occluders. They are migrated in place:
 * the three default parts are created and every existing node and edge is
 * assigned to the body, keeping all original ids.
 */
export function validateProject(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(input)) {
    return { ok: false, errors: ['File is not a JSON object.'] };
  }
  const version = input.version;
  if (
    !isFiniteNumber(version) ||
    version < MIN_SUPPORTED_VERSION ||
    version > SCHEMA_VERSION
  ) {
    return {
      ok: false,
      errors: [
        `Unsupported schema version ${String(version)}. Expected ${MIN_SUPPORTED_VERSION}–${SCHEMA_VERSION}.`,
      ],
    };
  }
  const migrating = version < SCHEMA_VERSION;

  if (!Array.isArray(input.nodes)) errors.push('"nodes" must be an array.');
  if (!Array.isArray(input.edges)) errors.push('"edges" must be an array.');
  if (!Array.isArray(input.poses)) errors.push('"poses" must be an array.');
  if (!isRecord(input.settings)) errors.push('"settings" must be an object.');
  if (input.parts !== undefined && !Array.isArray(input.parts)) {
    errors.push('"parts" must be an array when present.');
  }
  if (input.occluders !== undefined && !Array.isArray(input.occluders)) {
    errors.push('"occluders" must be an array when present.');
  }
  if (errors.length > 0) return { ok: false, errors };

  const rawNodes = input.nodes as unknown[];
  const rawEdges = input.edges as unknown[];
  const rawPoses = input.poses as unknown[];

  /* ------------------------------- parts ------------------------------ */

  const parts: GraphPart[] = [];
  const partIds = new Set<string>();
  const rawParts = Array.isArray(input.parts) ? input.parts : [];

  if (rawParts.length === 0) {
    // Schema 1, or a hand-written file with no layers: start from the default.
    for (const part of createDefaultParts()) {
      parts.push(part);
      partIds.add(part.id);
    }
    if (migrating) {
      warnings.push('Put everything on a single default part.');
    }
  } else {
    rawParts.forEach((raw, index) => {
      if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) {
        errors.push(`Part ${index} is missing a string "id".`);
        return;
      }
      if (partIds.has(raw.id)) {
        errors.push(`Duplicate part id "${raw.id}".`);
        return;
      }
      partIds.add(raw.id);
      parts.push({
        id: raw.id,
        name: typeof raw.name === 'string' ? raw.name : `Part ${index + 1}`,
        role: isPartRole(raw.role) ? raw.role : 'other',
        zIndex: isFiniteNumber(raw.zIndex) ? raw.zIndex : index * 10,
        renderEnabled: typeof raw.renderEnabled === 'boolean' ? raw.renderEnabled : true,
      });
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  // Everything needs somewhere to live if the file's own parts were unusable.
  const fallbackPartId = partIds.has(BODY_PART_ID) ? BODY_PART_ID : parts[0]!.id;

  /* ------------------------------- nodes ------------------------------ */

  const nodes: GraphNode[] = [];
  const nodeIds = new Set<string>();
  let repairedNodeParts = 0;
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
    const declaredPart = typeof raw.partId === 'string' ? raw.partId : null;
    if (declaredPart !== null && !partIds.has(declaredPart)) repairedNodeParts += 1;
    nodes.push({
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : `Node ${index + 1}`,
      partId: declaredPart && partIds.has(declaredPart) ? declaredPart : fallbackPartId,
      // Absent before schema 3; the defaults reproduce the old fixed dot.
      width: isFiniteNumber(raw.width) && raw.width > 0 ? raw.width : DEFAULT_NODE_WIDTH,
      brightness:
        isFiniteNumber(raw.brightness) && raw.brightness >= 0
          ? raw.brightness
          : DEFAULT_NODE_BRIGHTNESS,
    });
  });

  /* ------------------------------- edges ------------------------------ */

  const edges: GraphEdge[] = [];
  const edgeIds = new Set<string>();
  const edgePairs = new Set<string>();
  let repairedEdgeParts = 0;
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
    const declaredPart = typeof raw.partId === 'string' ? raw.partId : null;
    if (declaredPart !== null && !partIds.has(declaredPart)) repairedEdgeParts += 1;
    edges.push({
      id: raw.id,
      from: raw.from,
      to: raw.to,
      partId: declaredPart && partIds.has(declaredPart) ? declaredPart : fallbackPartId,
      width: isFiniteNumber(raw.width) ? raw.width : 2.4,
      brightness: isFiniteNumber(raw.brightness) ? raw.brightness : 1,
      seed: isFiniteNumber(raw.seed) ? raw.seed : 0,
    });
  });

  if (repairedNodeParts > 0) {
    warnings.push(`${repairedNodeParts} node(s) referenced an unknown part and were moved to the body.`);
  }
  if (repairedEdgeParts > 0) {
    warnings.push(`${repairedEdgeParts} edge(s) referenced an unknown part and were moved to the body.`);
  }

  /* ------------------------------- poses ------------------------------ */

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

  /* ----------------------------- occluders ---------------------------- */

  const occluders: OccluderPath[] = [];
  const occluderIds = new Set<string>();
  const rawOccluders = Array.isArray(input.occluders) ? input.occluders : [];
  rawOccluders.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) {
      errors.push(`Occluder ${index} is missing a string "id".`);
      return;
    }
    if (occluderIds.has(raw.id)) {
      errors.push(`Duplicate occluder id "${raw.id}".`);
      return;
    }
    if (!Array.isArray(raw.boundaryNodeIds)) {
      errors.push(`Occluder "${raw.id}" is missing a "boundaryNodeIds" array.`);
      return;
    }
    if (typeof raw.ownerPartId !== 'string' || !partIds.has(raw.ownerPartId)) {
      errors.push(`Occluder "${raw.id}" references a part that does not exist.`);
      return;
    }
    // Order is meaningful, so filter in place rather than rebuilding from a set.
    const seen = new Set<string>();
    const boundaryNodeIds: string[] = [];
    let dropped = 0;
    for (const value of raw.boundaryNodeIds as unknown[]) {
      if (typeof value !== 'string' || !nodeIds.has(value) || seen.has(value)) {
        dropped += 1;
        continue;
      }
      seen.add(value);
      boundaryNodeIds.push(value);
    }
    if (dropped > 0) {
      warnings.push(`Occluder "${raw.id}" dropped ${dropped} unknown or repeated boundary node(s).`);
    }
    if (boundaryNodeIds.length < MIN_BOUNDARY_NODES) {
      errors.push(
        `Occluder "${raw.id}" needs at least ${MIN_BOUNDARY_NODES} valid boundary nodes.`,
      );
      return;
    }
    const targetPartIds = Array.isArray(raw.targetPartIds)
      ? [
          ...new Set(
            (raw.targetPartIds as unknown[]).filter(
              (value): value is string => typeof value === 'string' && partIds.has(value),
            ),
          ),
        ]
      : [];
    occluderIds.add(raw.id);
    occluders.push({
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : `Occluder ${index + 1}`,
      ownerPartId: raw.ownerPartId,
      boundaryNodeIds,
      targetPartIds,
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      maskExpansion: isFiniteNumber(raw.maskExpansion)
        ? Math.max(0, raw.maskExpansion)
        : DEFAULT_MASK_EXPANSION,
    });
  });

  if (errors.length > 0) return { ok: false, errors };

  /* ------------------------------ settings ---------------------------- */

  const rawSettings = input.settings as Record<string, unknown>;
  const defaults = createDefaultSettings();
  const interpolation: InterpolationMode =
    rawSettings.interpolation === 'linear' || rawSettings.interpolation === 'catmull-rom'
      ? rawSettings.interpolation
      : defaults.interpolation;
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
    interpolation,
    tension:
      isFiniteNumber(rawSettings.tension) && rawSettings.tension >= 0 && rawSettings.tension <= 1
        ? rawSettings.tension
        : defaults.tension,
  };

  const reference = createDefaultReference();
  if (isRecord(input.reference)) {
    const raw = input.reference;
    if (typeof raw.visible === 'boolean') reference.visible = raw.visible;
    if (isFiniteNumber(raw.opacity)) reference.opacity = Math.min(1, Math.max(0, raw.opacity));
    if (isFiniteNumber(raw.x)) reference.x = raw.x;
    if (isFiniteNumber(raw.y)) reference.y = raw.y;
    if (isFiniteNumber(raw.scale) && raw.scale > 0) reference.scale = raw.scale;
  }

  poses.sort((a, b) => a.time - b.time);

  if (migrating) {
    warnings.push(`Migrated the project from schema ${String(version)} to ${SCHEMA_VERSION}.`);
  }

  // A missing or blank name is not an error: files written before names
  // existed, and hand-written ones, simply open as untitled.
  const rawName = typeof input.name === 'string' ? input.name.trim() : '';

  return {
    ok: true,
    warnings,
    project: {
      version: SCHEMA_VERSION,
      name: rawName || DEFAULT_PROJECT_NAME,
      // Persisted back to front, which is also the order the panel shows.
      parts: sortPartsByZ(parts),
      nodes,
      edges,
      poses,
      occluders,
      settings,
      reference,
    },
  };
}
