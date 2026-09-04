import Konva from 'konva';
import type { NodePosition, Pose } from '../model/types.ts';
import type { EditorStore } from '../state/EditorStore.ts';
import { normalizedToStage } from '../utils/coordinates.ts';

const PREVIOUS_COLOR = '#2fd8e8';
const NEXT_COLOR = '#f05be0';

/**
 * Ghosts of the neighbouring poses. The whole layer is non-listening, so onion
 * edges can never be clicked, and it is hidden outright in Preview mode.
 */
export class OnionSkinLayer {
  private store: EditorStore;
  private layer: Konva.Layer;
  private previousGroup = new Konva.Group({ listening: false });
  private nextGroup = new Konva.Group({ listening: false });

  constructor(store: EditorStore, layer: Konva.Layer) {
    this.store = store;
    this.layer = layer;
    layer.listening(false);
    layer.add(this.previousGroup);
    layer.add(this.nextGroup);
  }

  sync(): void {
    const state = this.store.state;
    const { onion } = state;
    const index = this.store.activePoseIndex;
    const poses = state.project.poses;

    const previous = onion.showPrevious && index > 0 ? poses[index - 1] : null;
    const next = onion.showNext && index >= 0 && index < poses.length - 1 ? poses[index + 1] : null;

    // Onion skins are a static reference; they are hidden while the timeline is
    // being played or scrubbed so the moving artwork stays legible.
    const suppressed = state.mode !== 'edit' || this.store.isPreviewingTimeline;

    this.renderPose(this.previousGroup, suppressed ? null : (previous ?? null), PREVIOUS_COLOR);
    this.renderPose(this.nextGroup, suppressed ? null : (next ?? null), NEXT_COLOR);
    this.layer.batchDraw();
  }

  private renderPose(group: Konva.Group, pose: Pose | null, color: string): void {
    group.destroyChildren();
    if (!pose) {
      group.visible(false);
      return;
    }
    group.visible(true);
    const state = this.store.state;
    const { settings } = state.project;
    const camera = state.camera;
    const opacity = state.onion.opacity;

    const toScreen = (position: NodePosition) => normalizedToStage(position, settings, camera);

    for (const edge of state.project.edges) {
      const from = pose.positions[edge.from];
      const to = pose.positions[edge.to];
      if (!from || !to) continue;
      const a = toScreen(from);
      const b = toScreen(to);
      group.add(
        new Konva.Line({
          points: [a.x, a.y, b.x, b.y],
          stroke: color,
          strokeWidth: Math.max(1, edge.width * camera.scale * 0.75),
          opacity,
          listening: false,
          lineCap: 'round',
          perfectDrawEnabled: false,
        }),
      );
    }

    if (state.onion.showNodes) {
      for (const node of state.project.nodes) {
        const position = pose.positions[node.id];
        if (!position) continue;
        const point = toScreen(position);
        group.add(
          new Konva.Circle({
            x: point.x,
            y: point.y,
            radius: 2.5,
            fill: color,
            opacity: opacity * 0.9,
            listening: false,
            perfectDrawEnabled: false,
          }),
        );
      }
    }
  }
}
