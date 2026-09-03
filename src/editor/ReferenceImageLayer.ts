import Konva from 'konva';
import type { CameraState } from '../model/types.ts';
import type { EditorStore } from '../state/EditorStore.ts';
import { projectToStage, stageToProject } from '../utils/coordinates.ts';

/**
 * The traced-over photo. It lives below everything else and is `listening:
 * false` while locked so it can never swallow an editor click. When unlocked it
 * becomes draggable; scaling stays uniform via the inspector slider.
 */
export class ReferenceImageLayer {
  private store: EditorStore;
  private layer: Konva.Layer;
  private image: Konva.Image;
  private element: HTMLImageElement | null = null;
  private loadToken = 0;

  constructor(store: EditorStore, layer: Konva.Layer) {
    this.store = store;
    this.layer = layer;
    this.image = new Konva.Image({ image: undefined, listening: false, visible: false });
    layer.add(this.image);
    this.image.on('dragend', () => this.commitDrag());
  }

  get hasImage(): boolean {
    return this.element !== null;
  }

  get naturalSize(): { width: number; height: number } | null {
    if (!this.element) return null;
    return { width: this.element.naturalWidth, height: this.element.naturalHeight };
  }

  /** Load from a data URL or a public path. Resolves false if it cannot load. */
  async load(src: string, options: { fit?: boolean; name?: string | null } = {}): Promise<boolean> {
    const token = ++this.loadToken;
    const element = await loadImageElement(src).catch(() => null);
    if (!element || token !== this.loadToken) return false;
    this.element = element;
    this.image.image(element);
    this.store.updateReference({
      src,
      name: options.name ?? fileNameFromSrc(src),
      naturalWidth: element.naturalWidth,
      naturalHeight: element.naturalHeight,
    });
    if (options.fit !== false) this.fitToProject();
    this.sync();
    return true;
  }

  clear(): void {
    this.loadToken += 1;
    this.element = null;
    this.image.image(undefined as unknown as HTMLImageElement);
    this.image.visible(false);
    this.store.updateReference({ src: null, name: null, naturalWidth: 0, naturalHeight: 0 });
    this.layer.batchDraw();
  }

  /** Contain the image inside the artwork area without distorting it. */
  fitToProject(): void {
    if (!this.element) return;
    const settings = this.store.state.project.settings;
    const scale = Math.min(
      settings.width / this.element.naturalWidth,
      settings.height / this.element.naturalHeight,
    );
    const width = this.element.naturalWidth * scale;
    const height = this.element.naturalHeight * scale;
    this.store.updateReference({
      scale,
      x: (settings.width - width) / 2,
      y: (settings.height - height) / 2,
    });
    this.sync();
  }

  /** Back to the untouched 1:1 placement at the artwork origin. */
  resetTransform(): void {
    this.store.updateReference({ x: 0, y: 0, scale: 1 });
    this.sync();
  }

  private commitDrag(): void {
    const camera = this.store.state.camera;
    const project = stageToProject({ x: this.image.x(), y: this.image.y() }, camera);
    this.store.updateReference({ x: project.x, y: project.y }, 'reference-drag', true);
  }

  /** Re-place the image for the current camera and reference settings. */
  sync(): void {
    const reference = this.store.state.reference;
    if (!this.element || !reference.visible) {
      this.image.visible(false);
      this.layer.batchDraw();
      return;
    }
    const camera: CameraState = this.store.state.camera;
    const origin = projectToStage({ x: reference.x, y: reference.y }, camera);
    this.image.setAttrs({
      image: this.element,
      visible: true,
      x: origin.x,
      y: origin.y,
      width: this.element.naturalWidth * reference.scale * camera.scale,
      height: this.element.naturalHeight * reference.scale * camera.scale,
      opacity: reference.opacity,
      listening: !reference.locked,
      draggable: !reference.locked,
    });
    this.layer.batchDraw();
  }

  destroy(): void {
    this.image.destroy();
  }
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error(`Could not load image: ${src}`));
    element.src = src;
  });
}

/**
 * Best-effort file name for an image loaded by path. A data URL carries no
 * name, so the caller has to supply one.
 */
function fileNameFromSrc(src: string): string | null {
  if (src.startsWith('data:')) return null;
  const withoutQuery = src.split(/[?#]/)[0] ?? src;
  const name = withoutQuery.split('/').pop();
  return name ? decodeURIComponent(name) : null;
}
