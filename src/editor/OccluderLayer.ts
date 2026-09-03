import Konva from 'konva';
import type { NodePosition, OccluderPath } from '../model/types.ts';
import type { EditorStore } from '../state/EditorStore.ts';
import { normalizedToStage } from '../utils/coordinates.ts';
import { PART_EDITOR_COLORS } from '../model/parts.ts';
import { resolveOccluderPolygon } from '../model/occluders.ts';

/**
 * Editor overlay for closed masking polygons.
 *
 * Occluders are invisible in the final animation, so they exist here purely as
 * a translucent hint. The whole layer is non-listening — outlines must never
 * swallow a click meant for the node underneath — and the fill is kept very
 * low so nodes stay readable through it. Owner part role picks the colour, so
 * a body silhouette and a near-wing silhouette never look alike.
 */
export class OccluderLayer {
  private store: EditorStore;
  private layer: Konva.Layer;
  private group = new Konva.Group({ listening: false });
  /** Shared with the editor so a frame is never sampled twice. */
  private positionsOf: () => Record<string, NodePosition>;

  constructor(
    store: EditorStore,
    layer: Konva.Layer,
    positionsOf: () => Record<string, NodePosition>,
  ) {
    this.store = store;
    this.layer = layer;
    this.positionsOf = positionsOf;
    layer.add(this.group);
  }

  sync(): void {
    const state = this.store.state;
    this.group.destroyChildren();

    const visible = state.mode === 'edit' && state.showOccluders;
    this.group.visible(visible);
    if (!visible) {
      this.layer.batchDraw();
      return;
    }

    const positions = this.positionsOf();
    const partStates = this.store.resolvedPartStates;

    for (const occluder of state.project.occluders) {
      // An occluder is hidden with its owner part, exactly like the geometry.
      const owner = partStates.get(occluder.ownerPartId);
      if (owner && !owner.visible) continue;

      const polygon = resolveOccluderPolygon(occluder, positions);
      if (!polygon) continue;

      const selected = state.selectedOccluderId === occluder.id;
      const editable = owner ? owner.interactive : true;
      const color = PART_EDITOR_COLORS[this.roleOf(occluder)];
      const points = this.flatten(polygon);

      this.group.add(
        new Konva.Line({
          points,
          closed: true,
          stroke: color,
          strokeWidth: selected ? 2 : 1.2,
          // A locked or hidden owner reads as a dashed ghost.
          dash: editable ? undefined : [5, 4],
          opacity: occluder.enabled ? 1 : 0.4,
          fill: this.fillFor(color, selected),
          listening: false,
          strokeScaleEnabled: false,
          perfectDrawEnabled: false,
          lineJoin: 'round',
        }),
      );

      if (selected) {
        for (const point of polygon) {
          const screen = this.toScreen(point);
          this.group.add(
            new Konva.Circle({
              x: screen.x,
              y: screen.y,
              radius: 4,
              stroke: color,
              strokeWidth: 1.5,
              listening: false,
              perfectDrawEnabled: false,
            }),
          );
        }
      }
    }

    this.layer.batchDraw();
  }

  private roleOf(occluder: OccluderPath): keyof typeof PART_EDITOR_COLORS {
    return this.store.partById(occluder.ownerPartId)?.role ?? 'other';
  }

  /** Very low alpha: the overlay must never obscure normal node editing. */
  private fillFor(color: string, selected: boolean): string {
    const alpha = selected ? 0.16 : 0.08;
    const value = color.replace('#', '');
    const r = Number.parseInt(value.slice(0, 2), 16);
    const g = Number.parseInt(value.slice(2, 4), 16);
    const b = Number.parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  private toScreen(position: NodePosition) {
    const state = this.store.state;
    return normalizedToStage(position, state.project.settings, state.camera);
  }

  private flatten(polygon: NodePosition[]): number[] {
    const points: number[] = [];
    for (const position of polygon) {
      const screen = this.toScreen(position);
      points.push(screen.x, screen.y);
    }
    return points;
  }
}
