import type { EditorStore } from '../state/EditorStore.ts';
import { AnimationPlayer } from '../runtime/AnimationPlayer.ts';

/** Marks the writes this bridge makes, so its own subscriber can skip them. */
const SOURCE = 'preview-player';

/**
 * Binds the editor's store to a store-free `AnimationPlayer`.
 *
 * The player is the shipping runtime: it owns a project, a playhead and a
 * render loop, and nothing in it knows the editor exists. Everything that made
 * it an *editor* component lives here instead — the store subscription that
 * feeds it, and the write-back that puts its clock into `playback`.
 *
 * Both directions are guarded against feeding each other: the player's own
 * frames are emitted under this module's source and ignored on the way back in.
 */
export class PreviewBridge {
  private store: EditorStore;
  private player: AnimationPlayer;

  constructor(canvas: HTMLCanvasElement, store: EditorStore) {
    this.store = store;
    this.player = new AnimationPlayer(canvas, store.state.project);
    this.player.seek(store.state.playback.time);
    this.player.setPlaying(store.state.playback.playing);

    this.player.onTime = (time, finished) => {
      const playback = this.store.state.playback;
      playback.time = time;
      if (!finished) {
        // 'raf' marks a frame tick: panels that only care about edits skip it.
        this.store.emit(['playback', 'positions'], 'raf');
        return;
      }
      playback.playing = false;
      this.store.emit(['playback', 'positions'], SOURCE);
    };

    store.subscribe((changes, source) => {
      if (source === 'raf') return;
      if (changes.has('project') || changes.has('settings')) {
        // Edits mutate the project in place, so this matters when the whole
        // document is replaced — an import, an undo, a new project.
        this.player.setProject(store.state.project);
      }
      if (source === SOURCE || !changes.has('playback')) return;
      this.player.setPlaying(store.state.playback.playing);
      this.player.seek(store.state.playback.time);
    });
  }

  start(): void {
    this.player.start();
  }

  stop(): void {
    this.player.stop();
  }

  resize(): void {
    this.player.resize();
  }

  exportDataUrl(): string {
    return this.player.exportDataUrl();
  }
}
