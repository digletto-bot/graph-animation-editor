import { describe, expect, it } from 'vitest';
import { parseProject, serializeProject } from '../src/model/serialization.ts';
import { validateProject } from '../src/model/projectValidation.ts';
import { addEdge, addNode, addPose, createEmptyProject } from '../src/model/projectFactory.ts';
import type { AnimationProject } from '../src/model/types.ts';

function buildProject(): AnimationProject {
  const project = createEmptyProject();
  const poseId = project.poses[0]!.id;
  const a = addNode(project, { x: 0.2, y: 0.3 }, poseId);
  const b = addNode(project, { x: 0.7, y: 0.4 }, poseId);
  const c = addNode(project, { x: 0.5, y: 0.85 }, poseId);
  addEdge(project, a, b, { width: 3.5, brightness: 1.4, seed: 4242 });
  addEdge(project, b, c);
  const second = addPose(project, poseId, 'Wing up');
  second.positions[a] = { x: 0.25, y: 0.1 };
  project.settings.lineColor = '#ffeedd';
  project.settings.duration = 3.5;
  return project;
}

describe('serialization round trip', () => {
  it('preserves the project exactly', () => {
    const original = buildProject();
    const result = parseProject(serializeProject(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.project.nodes).toEqual(original.nodes);
    expect(result.project.edges).toEqual(original.edges);
    expect(result.project.settings).toEqual(original.settings);
    expect(result.project.poses).toHaveLength(original.poses.length);
    original.poses.forEach((pose, index) => {
      const restored = result.project.poses[index]!;
      expect(restored.id).toBe(pose.id);
      expect(restored.name).toBe(pose.name);
      expect(restored.time).toBe(pose.time);
      expect(restored.positions).toEqual(pose.positions);
    });
  });

  it('keeps node ids and connectivity stable through two round trips', () => {
    const original = buildProject();
    const once = parseProject(serializeProject(original));
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = parseProject(serializeProject(once.project));
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.project.edges.map((edge) => [edge.from, edge.to])).toEqual(
      original.edges.map((edge) => [edge.from, edge.to]),
    );
  });

  it('includes a schema version and the reference transform but no image data', () => {
    const text = serializeProject(buildProject());
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.version).toBe(2);
    expect(parsed.reference).toBeDefined();
    expect(text).not.toContain('data:image');
    expect(text).not.toContain('"src"');
  });
});

describe('import validation', () => {
  it('rejects non-JSON text', () => {
    const result = parseProject('not json at all {');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/not valid JSON/i);
  });

  it('rejects a non-object payload', () => {
    const result = validateProject([1, 2, 3]);
    expect(result.ok).toBe(false);
  });

  it('rejects an unsupported schema version', () => {
    const result = validateProject({ version: 7, nodes: [], edges: [], poses: [], settings: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/schema version/i);
  });

  it('rejects missing collections with a readable message', () => {
    const result = validateProject({ version: 1, nodes: [], settings: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/"edges" must be an array/);
    expect(result.errors.join(' ')).toMatch(/"poses" must be an array/);
  });

  it('rejects edges pointing at unknown nodes', () => {
    const result = validateProject({
      version: 1,
      nodes: [{ id: 'n1', name: 'a' }],
      edges: [{ id: 'e1', from: 'n1', to: 'nope' }],
      poses: [{ id: 'p1', name: 'p', time: 0, positions: { n1: { x: 0, y: 0 } } }],
      settings: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/does not exist/);
  });

  it('rejects duplicate node ids', () => {
    const result = validateProject({
      version: 1,
      nodes: [
        { id: 'n1', name: 'a' },
        { id: 'n1', name: 'b' },
      ],
      edges: [],
      poses: [{ id: 'p1', name: 'p', time: 0, positions: {} }],
      settings: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/Duplicate node id/);
  });

  it('rejects a project with no poses', () => {
    const result = validateProject({ version: 1, nodes: [], edges: [], poses: [], settings: {} });
    expect(result.ok).toBe(false);
  });

  it('rejects a pose with a non-numeric time', () => {
    const result = validateProject({
      version: 1,
      nodes: [],
      edges: [],
      poses: [{ id: 'p1', name: 'p', time: 'soon', positions: {} }],
      settings: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/invalid "time"/);
  });

  it('repairs a missing position instead of failing outright', () => {
    const result = validateProject({
      version: 1,
      nodes: [{ id: 'n1', name: 'a' }],
      edges: [],
      poses: [{ id: 'p1', name: 'p', time: 0, positions: {} }],
      settings: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.poses[0]!.positions.n1).toEqual({ x: 0.5, y: 0.5 });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('falls back to defaults for invalid settings values', () => {
    const result = validateProject({
      version: 1,
      nodes: [],
      edges: [],
      poses: [{ id: 'p1', name: 'p', time: 0, positions: {} }],
      settings: { width: -5, duration: 'long', loop: 'yes' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.settings.width).toBe(1200);
    expect(result.project.settings.duration).toBe(4);
    expect(result.project.settings.loop).toBe(true);
  });
});
