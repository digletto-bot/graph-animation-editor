# Line Bird — graph animation editor

A browser-based editor for tracing line art as a node/edge graph, posing that
graph, and previewing the interpolated animation with a luminous glow pass.

## Install and run

```bash
npm install
npm run dev        # http://localhost:5173
```

Other commands:

```bash
npm run build      # tsc --noEmit + vite build
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run preview    # serve the production build
```

Drop a file at `public/reference-bird.png` and it loads automatically as the
initial reference image. The app works fine without one.

## Architecture

Two renderers over one authoritative store:

- **Edit mode** uses Konva (`src/editor/`). Five layers, bottom to top:
  background (frame, grid, reference image), onion skins, graph, overlay
  (marquee, lasso, snap hints), and the transform box. The non-interactive
  layers are `listening: false`.
- **Preview mode** uses raw Canvas 2D (`src/preview/`). Konva does not appear
  anywhere in its import graph, so `PreviewRenderer` + `interpolation.ts` +
  `glowRenderer.ts` are all a production site needs to ship.

`EditorStore` (`src/state/`) is the single source of truth. Konva shapes are a
projection of it and never become a second data model.

### Coordinates

Three spaces, converted through `src/utils/coordinates.ts`:

1. **Normalized** `0..1` over the artwork area — the only thing ever stored.
2. **Project** logical pixels (`settings.width` × `settings.height`).
3. **Stage** screen pixels after camera pan/zoom.

The camera is applied by computing screen positions per shape rather than by
scaling Konva layers, which keeps node hit areas constant in screen pixels at
any zoom. Panning and zooming never touch stored positions.

### History

Snapshot-based (`HistoryManager`), capped at 100 entries. A pointer drag or a
transformer gesture is bracketed by `beginTransaction`/`endTransaction`, so it
collapses to exactly one undo step. Selection, hover and camera are not
recorded.

### Transforms

The multi-node transform box drives a `Konva.Transformer` through a throw-away
proxy rectangle. Each node's offset is captured in the proxy's local space, then
mapped through the proxy's absolute transform each frame and written back as a
normalized position. Nothing is parented under a transformed group, so no
residual transform is left in the data model.

### Glow

Per frame: the wide halo for the whole network is drawn once into an offscreen
canvas, blurred once via `ctx.filter`, and composited back additively; then a
medium glow pass and a thin bright core pass. That is one blur per frame rather
than a shadow blur per edge. Per-edge variation is `sin(time + seedPhase)` from
the stored seed, so it is slow, smooth and identical between sessions.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `V` / `N` / `E` / `L` / `H` | Select / Add node / Add edge / Lasso / Pan |
| `Space + drag`, middle-drag | Temporary pan |
| Wheel | Zoom around the pointer |
| `Shift + click` | Add or remove from selection |
| `Alt + click` | Place a node ignoring snapping |
| `Shift` while scaling | Uniform scale |
| `Delete` / `Backspace` | Delete selection |
| `Escape` | Cancel operation or clear selection |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z`, `Ctrl/Cmd + Y` | Redo |
| `0` | Fit project in view |
| `P` | Toggle Edit/Preview |
| `?` | Shortcuts dialog |

Shortcuts are suppressed while typing in an input.

## Data format

Exported JSON carries `version`, `nodes`, `edges`, `poses`, `settings` and the
reference image's **transform only** — never the image bytes. Imports are
validated before they replace the live project, with readable errors. Valid
projects autosave to `localStorage` after meaningful changes.

## Tests

```
tests/coordinates.test.ts    coordinate round trips, camera, lasso geometry
tests/interpolation.test.ts  easing, pose-segment selection, reusable buffers
tests/project.test.ts        graph ops, duplicate edges, deletion cascade, poses
tests/serialization.test.ts  round trip, import validation
tests/history.test.ts        undo/redo, drag-as-one-entry, pose isolation
tests/flow.test.ts           end-to-end authoring flow, 200/500/10 scale check
tests/mount.test.ts          real app mounted in jsdom
tests/interaction.test.ts    pointer/keyboard input through the live editor
```

The last two mount the real application in jsdom with a node-canvas backend and
drive actual pointer events, so node creation, edge creation, dragging, marquee
selection, deletion, pan/zoom and preview pixel output are verified rather than
assumed.

## Known limitations

- Interpolation is linear with `easeInOutCubic`. The `EasingFunction` seam and
  `PoseSampler` are structured for Catmull–Rom, but it is not implemented.
- Drag and transform clamp stored positions to `[-0.25, 1.25]` rather than a
  hard `[0, 1]`; strict clamping would permanently squash a selection rotated
  near the frame edge. Node *creation* is restricted to `0..1` as specified.
- Pose reordering uses arrow buttons, not drag-and-drop.
- Reference image scaling is a slider; unlocked repositioning is by dragging on
  the stage.
- Background particles, tendrils and shaders are deliberately absent; the
  renderer is layered so they can be added as separate passes.
- Performance targets are met in a headless interpolation benchmark, but frame
  rate at 200 nodes / 500 edges has not been measured in a real browser.
