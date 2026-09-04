import { createEmptyProject } from '../../src/model/projectFactory.ts';
import { BODY_PART_ID, FAR_WING_PART_ID, NEAR_WING_PART_ID } from '../../src/runtime/parts.ts';
import { EditorStore } from '../../src/state/EditorStore.ts';
import type { AnimationProject } from '../../src/model/types.ts';

/**
 * A three-layer document, back to front.
 *
 * A new project now starts on a single generic part, which is too few to say
 * anything about layer ordering, membership, solo or masking. Those cases build
 * this instead: the bird-shaped preset earlier builds started from, kept here
 * as test scenery rather than as a product default.
 */
export function layeredProject(): AnimationProject {
  const project = createEmptyProject();
  project.parts = [
    { id: FAR_WING_PART_ID, name: 'Far wing', role: 'far-wing', zIndex: 0, renderEnabled: true },
    { id: BODY_PART_ID, name: 'Body', role: 'body', zIndex: 10, renderEnabled: true },
    {
      id: NEAR_WING_PART_ID,
      name: 'Near wing',
      role: 'near-wing',
      zIndex: 20,
      renderEnabled: true,
    },
  ];
  return project;
}

export function layeredStore(): EditorStore {
  return new EditorStore(layeredProject());
}
