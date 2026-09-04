import type { AnimationProject, NodePosition, OccluderPath } from './types.ts';

/**
 * Occluder geometry resolution.
 *
 * An occluder stores only *node ids*, never coordinates, so it follows every
 * pose and every interpolated frame for free. This module turns those ids into
 * a polygon, and caches the id -> buffer-index mapping so the Preview renderer
 * allocates nothing per frame.
 */

export const DEFAULT_MASK_EXPANSION = 2;
export const MIN_BOUNDARY_NODES = 3;

export interface OccluderIssue {
  occluderId: string;
  message: string;
}

/** Unique boundary nodes that still exist, in authored order. */
export function resolveBoundaryNodeIds(
  occluder: OccluderPath,
  knownNodeIds: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of occluder.boundaryNodeIds) {
    if (seen.has(id) || !knownNodeIds.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function isOccluderUsable(
  occluder: OccluderPath,
  knownNodeIds: ReadonlySet<string>,
): boolean {
  return resolveBoundaryNodeIds(occluder, knownNodeIds).length >= MIN_BOUNDARY_NODES;
}

/**
 * Reports dangling references and degenerate polygons. Returns an empty array
 * for a healthy project; the UI surfaces whatever comes back.
 */
export function validateOccluders(project: AnimationProject): OccluderIssue[] {
  const nodeIds = new Set(project.nodes.map((node) => node.id));
  const partIds = new Set(project.parts.map((part) => part.id));
  const issues: OccluderIssue[] = [];

  for (const occluder of project.occluders) {
    const missingNodes = occluder.boundaryNodeIds.filter((id) => !nodeIds.has(id));
    if (missingNodes.length > 0) {
      issues.push({
        occluderId: occluder.id,
        message: `“${occluder.name}” references ${missingNodes.length} node(s) that no longer exist.`,
      });
    }
    const usable = resolveBoundaryNodeIds(occluder, nodeIds);
    if (usable.length < MIN_BOUNDARY_NODES) {
      issues.push({
        occluderId: occluder.id,
        message: `“${occluder.name}” needs at least ${MIN_BOUNDARY_NODES} valid boundary nodes (has ${usable.length}).`,
      });
    }
    if (!partIds.has(occluder.ownerPartId)) {
      issues.push({
        occluderId: occluder.id,
        message: `“${occluder.name}” belongs to a part that no longer exists.`,
      });
    }
    const missingTargets = occluder.targetPartIds.filter((id) => !partIds.has(id));
    if (missingTargets.length > 0) {
      issues.push({
        occluderId: occluder.id,
        message: `“${occluder.name}” targets ${missingTargets.length} part(s) that no longer exist.`,
      });
    }
  }
  return issues;
}

/**
 * Polygon in normalized space from a plain position record (editor overlays).
 * Returns null when the polygon is degenerate, so callers can skip it.
 */
export function resolveOccluderPolygon(
  occluder: OccluderPath,
  positions: Record<string, NodePosition>,
): NodePosition[] | null {
  const points: NodePosition[] = [];
  const seen = new Set<string>();
  for (const id of occluder.boundaryNodeIds) {
    if (seen.has(id)) continue;
    const position = positions[id];
    if (!position) continue;
    seen.add(id);
    points.push(position);
  }
  return points.length >= MIN_BOUNDARY_NODES ? points : null;
}

/** Occluders that erase `partId` and are switched on. */
export function occludersTargeting(project: AnimationProject, partId: string): OccluderPath[] {
  return project.occluders.filter(
    (occluder) => occluder.enabled && occluder.targetPartIds.includes(partId),
  );
}

/**
 * Per-frame view of the occluders, with boundary node ids already resolved to
 * indices into the sampler's interleaved position buffer.
 *
 * `sync` runs on topology change only; `polygonInto` writes into a caller-owned
 * scratch array, so a rendered frame performs zero allocations.
 */
export interface CompiledOccluder {
  id: string;
  enabled: boolean;
  targetPartIds: string[];
  maskExpansion: number;
  /** Indices into the interleaved [x0,y0,x1,y1,...] position buffer. */
  indices: Int32Array;
}

export class OccluderResolver {
  private compiled: CompiledOccluder[] = [];
  private topologyKey = '';

  /** Rebuilds the index cache only when the topology or the occluders change. */
  sync(project: AnimationProject, indexOf: (nodeId: string) => number): void {
    const key =
      project.occluders
        .map(
          (occluder) =>
            `${occluder.id}:${occluder.enabled ? 1 : 0}:${occluder.maskExpansion}:` +
            `${occluder.targetPartIds.join('|')}:${occluder.boundaryNodeIds.join('>')}`,
        )
        .join(';') + `#${project.nodes.length}:${project.nodes.map((n) => n.id).join(',')}`;
    if (key === this.topologyKey) return;
    this.topologyKey = key;

    this.compiled = project.occluders.map((occluder) => {
      const indices: number[] = [];
      const seen = new Set<string>();
      for (const nodeId of occluder.boundaryNodeIds) {
        if (seen.has(nodeId)) continue;
        const index = indexOf(nodeId);
        if (index < 0) continue;
        seen.add(nodeId);
        indices.push(index);
      }
      return {
        id: occluder.id,
        enabled: occluder.enabled,
        targetPartIds: [...occluder.targetPartIds],
        maskExpansion: occluder.maskExpansion,
        indices: Int32Array.from(indices),
      };
    });
  }

  /** Compiled occluders that erase `partId`, enabled and non-degenerate. */
  forTarget(partId: string): CompiledOccluder[] {
    return this.compiled.filter(
      (occluder) =>
        occluder.enabled &&
        occluder.indices.length >= MIN_BOUNDARY_NODES &&
        occluder.targetPartIds.includes(partId),
    );
  }

  get all(): readonly CompiledOccluder[] {
    return this.compiled;
  }
}
