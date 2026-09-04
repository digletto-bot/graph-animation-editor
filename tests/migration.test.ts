import { describe, expect, it } from 'vitest';
import { validateProject, SCHEMA_VERSION } from '../src/model/projectValidation.ts';
import { parseProject, serializeProject } from '../src/model/serialization.ts';
import {
  DEFAULT_NODE_BRIGHTNESS,
  DEFAULT_NODE_WIDTH,
} from '../src/model/projectFactory.ts';
import { BODY_PART_ID, DEFAULT_PART_ID } from '../src/runtime/parts.ts';
import { layeredProject, layeredStore } from './support/layeredProject.ts';

/** A complete, valid schema 1 document exactly as the previous build wrote it. */
function schemaOneProject() {
  return {
    version: 1,
    nodes: [
      { id: 'node_a', name: 'Beak' },
      { id: 'node_b', name: 'Tail' },
      { id: 'node_c', name: 'Wing tip' },
    ],
    edges: [
      { id: 'edge_a', from: 'node_a', to: 'node_b', width: 3.5, brightness: 1.4, seed: 4242 },
      { id: 'edge_b', from: 'node_b', to: 'node_c', width: 2.4, brightness: 1, seed: 17 },
    ],
    poses: [
      {
        id: 'pose_1',
        name: 'Rest',
        time: 0,
        positions: {
          node_a: { x: 0.2, y: 0.3 },
          node_b: { x: 0.7, y: 0.4 },
          node_c: { x: 0.5, y: 0.85 },
        },
      },
      {
        id: 'pose_2',
        name: 'Wing up',
        time: 2,
        positions: {
          node_a: { x: 0.25, y: 0.1 },
          node_b: { x: 0.7, y: 0.4 },
          node_c: { x: 0.5, y: 0.85 },
        },
      },
    ],
    settings: {
      width: 1200,
      height: 800,
      duration: 4,
      loop: true,
      lineColor: '#ffeedd',
      glowColor: '#ffd9a0',
      backgroundColor: '#05060a',
      showPreviewNodes: false,
    },
    reference: { visible: true, opacity: 0.4, locked: true, x: 12, y: 8, scale: 1.5 },
  };
}

describe('schema 1 migration', () => {
  it('accepts a schema 1 project and stamps the current version', () => {
    const result = validateProject(schemaOneProject());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(3);
    expect(result.warnings.join(' ')).toMatch(/Migrated the project from schema 1/);
  });

  it('puts a partless file on the single default part', () => {
    const result = validateProject(schemaOneProject());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.parts.map((part) => part.id)).toEqual([DEFAULT_PART_ID]);
    expect(result.project.parts.every((part) => part.renderEnabled)).toBe(true);
  });

  it('defaults every existing node and edge to that part', () => {
    const result = validateProject(schemaOneProject());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.nodes.every((node) => node.partId === DEFAULT_PART_ID)).toBe(true);
    expect(result.project.edges.every((edge) => edge.partId === DEFAULT_PART_ID)).toBe(true);
  });

  it('keeps every original node, edge and pose id', () => {
    const original = schemaOneProject();
    const result = validateProject(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.nodes.map((node) => node.id)).toEqual(
      original.nodes.map((node) => node.id),
    );
    expect(result.project.edges.map((edge) => edge.id)).toEqual(
      original.edges.map((edge) => edge.id),
    );
    expect(result.project.poses.map((pose) => pose.id)).toEqual(
      original.poses.map((pose) => pose.id),
    );
    expect(result.project.nodes.map((node) => node.name)).toEqual(
      original.nodes.map((node) => node.name),
    );
  });

  it('preserves pose positions, timing, settings and the reference transform', () => {
    const original = schemaOneProject();
    const result = validateProject(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.poses[1]!.positions).toEqual(original.poses[1]!.positions);
    expect(result.project.poses[1]!.time).toBe(2);
    expect(result.project.settings.lineColor).toBe('#ffeedd');
    expect(result.project.settings.duration).toBe(4);
    // The old `locked` flag is dropped: the Reference tool decides when the
    // image moves now. The transform it guarded still survives intact.
    const { visible, opacity, x, y, scale } = original.reference;
    expect(result.project.reference).toEqual({ visible, opacity, x, y, scale });
    expect(result.project.reference).not.toHaveProperty('locked');
    expect(result.project.edges[0]!.seed).toBe(4242);
    expect(result.project.edges[0]!.brightness).toBe(1.4);
  });

  it('starts a migrated project with no occluders and default interpolation settings', () => {
    const result = validateProject(schemaOneProject());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.occluders).toEqual([]);
    expect(result.project.settings.interpolation).toBe('catmull-rom');
    expect(result.project.settings.tension).toBe(0.5);
  });

  it('migrates through the JSON import path too', () => {
    const result = parseProject(JSON.stringify(schemaOneProject()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.version).toBe(SCHEMA_VERSION);
    expect(result.project.nodes[0]!.partId).toBe(DEFAULT_PART_ID);
  });

  it('still rejects a schema version this build cannot read', () => {
    const older = validateProject({ ...schemaOneProject(), version: 0 });
    const newer = validateProject({ ...schemaOneProject(), version: 7 });
    expect(older.ok).toBe(false);
    expect(newer.ok).toBe(false);
    if (newer.ok) return;
    expect(newer.errors[0]).toMatch(/schema version/i);
  });

  it('rebuilds a part for a version 2 file that lost them', () => {
    const result = validateProject({ ...schemaOneProject(), version: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.parts).toHaveLength(1);
    expect(result.project.nodes.every((node) => node.partId === DEFAULT_PART_ID)).toBe(true);
  });
});

describe('schema 2 -> 3: node appearance', () => {
  /** A schema 2 project: parts and occluders present, node width/brightness not. */
  function schemaTwoProject() {
    const project = JSON.parse(JSON.stringify(schemaOneProject())) as Record<string, unknown>;
    project.version = 2;
    project.parts = layeredProject().parts;
    project.occluders = [];
    for (const node of project.nodes as Record<string, unknown>[]) node.partId = BODY_PART_ID;
    for (const edge of project.edges as Record<string, unknown>[]) edge.partId = BODY_PART_ID;
    return project;
  }

  it('gives every node the defaults that reproduce the old fixed dot', () => {
    const result = validateProject(schemaTwoProject());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const node of result.project.nodes) {
      expect(node.width).toBe(DEFAULT_NODE_WIDTH);
      expect(node.brightness).toBe(DEFAULT_NODE_BRIGHTNESS);
    }
    expect(result.project.version).toBe(SCHEMA_VERSION);
  });

  it('preserves every node id and part through the bump', () => {
    const before = schemaTwoProject();
    const result = validateProject(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.nodes.map((node) => node.id)).toEqual(
      (before.nodes as { id: string }[]).map((node) => node.id),
    );
    for (const node of result.project.nodes) expect(node.partId).toBe(BODY_PART_ID);
  });

  it('keeps authored values when they are already present', () => {
    const project = schemaTwoProject();
    (project.nodes as Record<string, unknown>[])[0]!.width = 5;
    (project.nodes as Record<string, unknown>[])[0]!.brightness = 0.25;
    const result = validateProject(project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.nodes[0]!.width).toBe(5);
    expect(result.project.nodes[0]!.brightness).toBe(0.25);
  });

  it('falls back to the defaults for nonsense values', () => {
    const project = schemaTwoProject();
    (project.nodes as Record<string, unknown>[])[0]!.width = -3;
    (project.nodes as Record<string, unknown>[])[0]!.brightness = 'bright';
    const result = validateProject(project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.nodes[0]!.width).toBe(DEFAULT_NODE_WIDTH);
    expect(result.project.nodes[0]!.brightness).toBe(DEFAULT_NODE_BRIGHTNESS);
  });

  it('round-trips node appearance through export and import', () => {
    const store = layeredStore();
    const id = store.addNodeAt({ x: 0.4, y: 0.4 });
    store.updateNode(id, { width: 7.5, brightness: 0.4 });
    const result = parseProject(serializeProject(store.state.project));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const restored = result.project.nodes.find((node) => node.id === id)!;
    expect(restored.width).toBe(7.5);
    expect(restored.brightness).toBe(0.4);
  });
});
