import { describe, expect, it } from 'vitest';
import { EditorStore } from '../src/state/EditorStore.ts';
import {
  createEmptyProject,
  redistributePoseTimes,
  rescalePoseTimes,
} from '../src/model/projectFactory.ts';
import type { AnimationProject } from '../src/model/types.ts';

/** A project whose poses sit at the given times, with the given duration. */
function timed(times: number[], duration: number): AnimationProject {
  const project = createEmptyProject();
  project.settings.duration = duration;
  project.poses = times.map((time, index) => ({
    id: `p${index}`,
    name: `Pose ${index + 1}`,
    time,
    positions: {},
  }));
  return project;
}

const timesOf = (project: AnimationProject) => project.poses.map((pose) => pose.time);

describe('changing the duration re-times the poses', () => {
  it('squeezes the whole timeline instead of piling poses on the end', () => {
    // The reported bug: 4s -> 2s clamped everything past 2s onto 2s, giving
    // 0, 0.8, 1.6, 2, 2, 2 and collapsing the tail of the animation.
    const project = timed([0, 0.8, 1.6, 2.4, 3.2, 4], 4);
    project.settings.duration = 2;
    rescalePoseTimes(project, 4);
    expect(timesOf(project)).toEqual([0, 0.4, 0.8, 1.2, 1.6, 2]);
  });

  it('stretches the same way when the duration grows', () => {
    const project = timed([0, 0.4, 0.8, 1.2, 1.6, 2], 2);
    project.settings.duration = 4;
    rescalePoseTimes(project, 2);
    expect(timesOf(project)).toEqual([0, 0.8, 1.6, 2.4, 3.2, 4]);
  });

  it('preserves deliberate uneven spacing in proportion', () => {
    // A fast snap then a slow glide must stay a fast snap and a slow glide.
    const project = timed([0, 0.2, 3, 4], 4);
    project.settings.duration = 8;
    rescalePoseTimes(project, 4);
    expect(timesOf(project)).toEqual([0, 0.4, 6, 8]);
  });

  it('keeps every pose inside the new duration and strictly ordered', () => {
    const project = timed([0, 1, 2, 3, 4], 4);
    project.settings.duration = 0.02;
    rescalePoseTimes(project, 4);
    const times = timesOf(project);
    expect(Math.max(...times)).toBeLessThanOrEqual(0.02);
    for (let i = 1; i < times.length; i += 1) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
  });

  it('leaves the times alone when the duration did not change', () => {
    const project = timed([0, 0.2, 3, 4], 4);
    rescalePoseTimes(project, 4);
    expect(timesOf(project)).toEqual([0, 0.2, 3, 4]);
  });

  it('runs on the store when the duration is edited, as one undoable step', () => {
    const store = new EditorStore();
    store.state.project.settings.duration = 4;
    store.state.project.poses = timed([0, 0.8, 1.6, 2.4, 3.2, 4], 4).poses;

    store.updateSettings({ duration: 2 });
    expect(timesOf(store.state.project)).toEqual([0, 0.4, 0.8, 1.2, 1.6, 2]);

    expect(store.undo()).toBe(true);
    expect(timesOf(store.state.project)).toEqual([0, 0.8, 1.6, 2.4, 3.2, 4]);
    expect(store.state.project.settings.duration).toBe(4);
  });

  it('does not disturb pose times when another setting changes', () => {
    const store = new EditorStore();
    store.state.project.poses = timed([0, 0.2, 3, 4], 4).poses;
    store.updateSettings({ loop: false });
    expect(timesOf(store.state.project)).toEqual([0, 0.2, 3, 4]);
  });
});

describe('distributing frames on demand', () => {
  it('spaces poses evenly across the duration, endpoints included', () => {
    const project = timed([0, 0.1, 0.2, 0.3, 4], 4);
    redistributePoseTimes(project);
    expect(timesOf(project)).toEqual([0, 1, 2, 3, 4]);
  });

  it('re-times without touching order, names or positions', () => {
    const store = new EditorStore();
    const node = store.addNodeAt({ x: 0.3, y: 0.7 });
    while (store.state.project.poses.length < 4) store.addPoseAfterActive();
    store.state.project.poses.forEach((pose, index) => {
      pose.time = index * 0.05;
    });
    const names = store.state.project.poses.map((pose) => pose.name);
    const ids = store.state.project.poses.map((pose) => pose.id);

    expect(store.distributePoseTimes()).toBe(true);

    const project = store.state.project;
    const { duration } = project.settings;
    const gaps = project.poses.slice(1).map((pose, i) => pose.time - project.poses[i]!.time);
    for (const gap of gaps) expect(gap).toBeCloseTo(duration / 3, 3);
    expect(project.poses[0]!.time).toBe(0);
    expect(project.poses[3]!.time).toBeCloseTo(duration, 4);
    expect(project.poses.map((pose) => pose.name)).toEqual(names);
    expect(project.poses.map((pose) => pose.id)).toEqual(ids);
    for (const pose of project.poses) expect(pose.positions[node]).toEqual({ x: 0.3, y: 0.7 });
  });

  it('is one undoable step', () => {
    const store = new EditorStore();
    while (store.state.project.poses.length < 3) store.addPoseAfterActive();
    store.state.project.poses[1]!.time = 0.05;
    store.distributePoseTimes();
    expect(store.undo()).toBe(true);
    expect(store.state.project.poses[1]!.time).toBe(0.05);
  });

  it('refuses when there is nothing to spread', () => {
    const store = new EditorStore();
    expect(store.state.project.poses).toHaveLength(1);
    expect(store.distributePoseTimes()).toBe(false);
    expect(store.canUndo).toBe(false);
  });

  it('keeps playback parked on the active pose', () => {
    const store = new EditorStore();
    while (store.state.project.poses.length < 4) store.addPoseAfterActive();
    store.setActivePose(store.state.project.poses[2]!.id);
    store.state.project.poses.forEach((pose, index) => {
      pose.time = index * 0.05;
    });
    store.distributePoseTimes();
    expect(store.state.playback.time).toBe(store.state.project.poses[2]!.time);
  });
});
