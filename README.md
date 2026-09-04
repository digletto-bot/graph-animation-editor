# Line Bird — graph animation editor

A browser-based editor for tracing line art as a node/edge graph, posing that
graph, and previewing the interpolated animation with a luminous glow pass.

Two things live here, built from one codebase:

- **the editor** — the app you author animations in, and export as JSON
- **the player** (`line-bird` on npm) — an ES module that plays that JSON on
  any page, with no editor, no Konva and no dependencies

## Playing an animation on a page

```bash
npm install line-bird
```

```js
import { mount } from 'line-bird';

const player = await mount('#hero', { src: '/bird.json' });
```

`mount` fetches the file, validates it, sizes a canvas into the element you
name, and starts playing. It also does the two things an embedded animation
owes the page it sits on: it stops the clock while scrolled out of view, and
holds a still frame for a viewer whose system asks for reduced motion. Both are
on by default and can be switched off.

```js
await mount('#hero', {
  src: '/bird.json',        // or project: <an already-loaded document>
  autoplay: true,           // default
  loop: true,               // omit to use whatever the project says
  trusted: false,           // true skips validation for your own documents
  pauseWhenOffscreen: true, // default
  respectReducedMotion: true, // default
});
```

The returned `AnimationPlayer` is the transport: `play()`, `pause()`,
`seek(seconds)`, `setProject(project)`, `time`, `playing`, `destroy()`, and an
`onTime(time, finished)` callback for driving something else from the playhead.
Construct one directly when your app has its own loading and layout:

```js
import { AnimationPlayer } from 'line-bird';

const player = new AnimationPlayer(canvas, project);
player.start();   // render loop
player.play();    // and run the clock
```

### As one HTML tag

```html
<script type="module" src="https://esm.sh/line-bird/element"></script>

<line-bird src="/bird.json" style="height: 320px"></line-bird>
```

Importing that module registers `<line-bird>`. Attributes: `src`, `paused`,
`loop`, `pause-offscreen="false"`, `reduced-motion="ignore"`. The element fires
`load` when the animation is running and `error` if the file could not be used
— a broken animation never takes the page down with it — and exposes the player
as `element.animation`.

### With no build step at all

`line-bird/standalone` is the whole runtime inlined into one file that imports
nothing — no chunks to resolve, so it works straight off disk:

```html
<script type="module" src="./assets/line-bird.standalone.js"></script>
<line-bird src="./bird.json" style="height: 320px"></line-bird>
```

Importing it registers the tag *and* exports `mount`, `AnimationPlayer` and
`validateProject`, so a page with no bundler gets the full API from one
`<script type="module">`. Copy `dist/runtime/line-bird.standalone.js` next to
your page after `npm run build:runtime`.

A published version can also come from a CDN, where the split entry points are
fine because the CDN resolves their chunks:

```html
<script type="importmap">
  { "imports": { "line-bird": "https://esm.sh/line-bird" } }
</script>
```

### Entry points

| Import | What it is | Size (gzipped) |
| --- | --- | --- |
| `line-bird` | player + `mount` | ~6 kB |
| `line-bird/validate` | schema validation for untrusted files | ~3 kB |
| `line-bird/element` | registers `<line-bird>` | ~0.7 kB |
| `line-bird/standalone` | all three, inlined into one import-free file | ~8.7 kB |

Validation is its own entry point so an app that trusts its own documents can
leave it out, and the custom element is separate because importing a player
should not register an element as a side effect. The standalone file gives both
of those up deliberately — it is for the case where there is nothing to
tree-shake with.

## The editor

```bash
npm install
npm run dev        # http://localhost:5173
```

The top bar holds only what is used constantly: the Edit/Preview switch, undo
and redo, and the project's name — the name titles the document and names the
files it exports. Everything occasional is behind **Menu**: JSON export and
import, save/load in this browser, **New project** (which discards the open one,
so export it first), and the keyboard shortcut list.

Trace a reference image with the node and edge tools, pose the graph on the
timeline, watch it in Preview, then **Export JSON** — that file is what the
player above takes.

### Commands

```bash
npm run build          # typecheck, build the editor app, then the player
npm run build:runtime  # just the player: dist/runtime/*.js + type declarations
npm test               # vitest run
npm run typecheck      # tsc --noEmit
npm run preview        # serve the production build
```

`npm run build` writes the editor to `dist/` and the player to `dist/runtime/`.
Only the latter is published: `files` in `package.json` covers `dist/runtime`,
and `prepack` rebuilds it, so `npm publish` cannot ship a stale bundle.

Drop a file at `public/reference-bird.png` and it loads automatically as the
initial reference image for a fresh session. You can also drag any PNG, JPEG or WebP onto the
window at any time, or use the inspector's upload button. The app works fine
without a reference.

## Architecture

Two renderers over one authoritative store:

- **Edit mode** uses Konva (`src/editor/`). Six layers, bottom to top:
  background (frame, grid, reference image), onion skins, graph, occluder
  outlines, overlay (marquee, lasso, snap hints, tool previews), and the
  transform box. Only the graph and transform layers listen; the other four are
  `listening: false` and exist purely for paint order.
- **Preview mode** uses raw Canvas 2D, and is not editor code at all: it is
  `src/runtime/`, the embeddable player (below).

`EditorStore` (`src/state/`) is the single source of truth. Konva shapes are a
projection of it and never become a second data model.

### The runtime (`src/runtime/`)

Everything needed to play a project on a canvas, and nothing else:
`AnimationPlayer` plus `interpolation.ts`, `glowRenderer.ts`, `partCanvas.ts`,
`nodeDots.ts`, `occluders.ts`, part ordering and the document types. It owns a
project, a playhead and a render loop, and has no idea the editor exists —
which is what makes it shippable to a site that only wants to display an
animation.

```
src/runtime/   the player: no store, no Konva, no dependencies at all
src/model/     document operations, validation, editor-only part display
src/editor/    Konva stage, tools, camera
src/state/     EditorStore
src/app/       composition root, and PreviewBridge
```

The editor consumes the runtime rather than containing a second copy of it.
`app/PreviewBridge.ts` is the whole of the coupling: it feeds the store's
project into an `AnimationPlayer` and writes the player's clock back into
`playback`, marking its own writes so the two cannot drive each other in a
loop. Frame ticks keep the `'raf'` source the panels already skip.

`tests/runtimeBoundary.test.ts` enforces the separation — no import out of
`src/runtime/`, no third-party package, no reference to editor-only part
display — because nothing else would fail if someone reached for `EditorStore`
from inside a renderer. `runtime/index.ts`, `runtime/validate.ts` and
`runtime/element.ts` are the published entry points, built by
`vite.runtime.config.ts` into ES modules with declarations from
`tsconfig.runtime.json`. `runtime/standalone.ts` re-exports all three and is
built separately by `vite.standalone.config.ts` with code splitting off, so the
one file it produces has no imports for a page without a bundler to resolve.

### Parts and occlusion

The graph is layered. Every node and edge carries a `partId`, and parts are
ordered back to front by a static `zIndex`. A new project starts with one part,
"Part 1"; add as many as the artwork needs and order them in the parts panel.
The last remaining part cannot be deleted, since geometry would have nowhere to
live.

A part also carries a `role` (`far-wing`, `body`, `near-wing`, `other`), which
only picks its editor overlay colour and seeds occluder targets. New parts are
always `other`; the three named roles exist for projects authored when the
editor shipped a fixed bird rig.

Layers that should hide each other do so through **occluders** — closed
polygons whose vertices are *references to graph nodes*, never copies of
coordinates, so they follow every pose and every interpolated frame for free.
Preview draws each part into its own reused offscreen canvas, punches every
occluder targeting it out with `destination-out`, then composites the layers in
z-order. Because the hole is cut in the part's own alpha, the blurred glow
disappears with the sharp lines; nothing is ever painted over in the background
colour, so the parts in front stay line-based and unfilled.

`maskExpansion` grows a mask outward by filling the polygon and stroking it,
which keeps glow from leaking across the silhouette edge.

### Resizing the artboard

Positions are fractions of the artwork area, so changing its width or height
alone would squash the drawing. With **Keep artwork proportions** on (the
default, an editor preference), a resize remaps every pose: the artwork keeps
its proportions, is centred on the new board, and is scaled down only when the
board shrank — `refitArtworkToSize` in `model/projectFactory.ts`. The reference
image is carried through the same transform so a tracing stays on its source.

**Scale artwork** applies a uniform factor to every pose about the centre of the
board. Scaling up can push nodes past the frame; they are kept rather than
clamped, since clamping only the nodes that overshoot would deform the artwork
the scale exists to preserve.

Editor-only display state — lock, hide, solo and x-ray — lives in the editor
preferences, never in the project, and the Preview renderer cannot reach it.
Runtime visibility is the separate, exported `renderEnabled` flag.

Moving nodes to another part takes their *internal* edges along — an edge whose
both endpoints move. An edge spanning two parts has no obvious home, so it keeps
the part it had; its own `partId` always decides its render layer.

The rail's pick filter (`Q`) restricts what the pointer grabs. In edges-only
mode the marquee sweeps every edge it crosses and the lasso takes edges by
midpoint, which is how you select and delete edges buried under a node cluster.

### Appearance

Nodes and edges each carry a `width` and a `brightness`, editable in the
inspector for one item or for a whole selection at once. When a multi-selection
disagrees, the slider starts at the mean and the hint says so rather than
implying the selection is uniform.

Both properties are **output** properties, and Preview is where they are judged:

- **Edges** render at their own width and brightness in Preview. The editor
  deliberately draws every edge at one weight, so a heavy edge does not swamp
  its neighbours while tracing.
- **Nodes** render as drawn artwork in Preview — an additive halo in the glow
  colour, then a bright core in the line colour, sized by `width` and scaled by
  `brightness`. A node at brightness 0 draws nothing, which is how you keep a
  node out of the output without deleting it.

The separate "Node markers in preview" setting is an unrelated flat placement
overlay at one fixed size, drawn on top and ignoring node appearance entirely.

### Poses and timing

Poses are cards on the timeline, not one track per node — a 200-node rig would
otherwise produce 200 unreadable rows. Changing the animation duration rescales
every pose time in proportion, so deliberate uneven timing survives; **Distribute
frames** spreads them evenly on demand. Scrubbing always pauses playback and
resumes on release if it had been playing.

### Interpolation

`settings.interpolation` selects `linear` (lerp through `easeInOutCubic`) or
`catmull-rom` (time-aware cubic Hermite with Catmull-Rom tangents). Smooth mode
passes exactly through every authored pose, respects non-uniform pose times,
and wraps neighbour indices and times when looping so the final-to-first
transition has no positional or velocity snap. `settings.tension` (0..1) scales
the tangents; tangents flatten at direction reversals and are capped against the
adjacent secants, so a wing does not swing past the pose the animator authored.
The scalar helpers (`hermite`, `catmullRomTangent`, `PoseCurve`) are channel
agnostic on purpose.

### Coordinates

Three spaces, converted through `src/utils/coordinates.ts`:

1. **Normalized** `0..1` over the artwork area — the only thing ever stored.
2. **Project** logical pixels (`settings.width` × `settings.height`).
3. **Stage** screen pixels after camera pan/zoom.

The camera is applied by computing screen positions per shape rather than by
scaling Konva layers, which keeps node hit areas constant in screen pixels at
any zoom. Panning and zooming never touch stored positions.

### History

Snapshot-based (`HistoryManager`), capped at 100 entries. A pointer drag, a
transformer gesture or an inspector slider drag is bracketed by
`beginTransaction`/`endTransaction`, so each collapses to exactly one undo step;
data edits made while a transaction is open fold into it instead of pushing
their own entry. Selection, hover and camera are not recorded.

### Transforms

The multi-node transform box drives a `Konva.Transformer` through a throw-away
proxy rectangle. Each node's offset is captured in the proxy's local space, then
mapped through the proxy's absolute transform each frame and written back as a
normalized position. Nothing is parented under a transformed group, so no
residual transform is left in the data model.

### Glow

Five passes per part, per frame: the wide edge halo for the whole network is
drawn once into an offscreen canvas, blurred once via `ctx.filter` and
composited back additively; then a medium edge glow, a thin bright edge core,
an additive node halo and a node core. That is one blur per frame rather than a
shadow blur per edge. Per-edge variation is `sin(time + seedPhase)` from the
stored seed, so it is slow, smooth and identical between sessions.

Edge and node appearance is copied into the draw buffers every frame rather than
on a topology change. The buffers already exist, so it is a fixed number of
numeric writes with no allocation, and there is no way for the canvas to render
a value the inspector has already changed.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `V` / `N` / `E` / `L` / `H` | Select / Add node / Add edge / Lasso / Pan |
| `O` | Occluder tool |
| `R` | Move the reference image |
| `Q` | Cycle selection: nodes and edges / nodes only / edges only |
| `Enter` | Close the occluder polygon being drawn |
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

Exported JSON carries `version`, `name`, `parts`, `nodes`, `edges`, `poses`,
`occluders`, `settings` and the reference image's **transform only** — never the
image bytes. It is the same file on both sides: the editor writes it, and the
player reads it.

`validateProject` (`runtime/validate.ts`, published as `line-bird/validate`)
checks and repairs an untrusted document before either side uses it, returning
readable errors rather than throwing. The editor runs it on import; the player
runs it in `mount()` unless you pass `trusted: true`. Valid projects autosave to
`localStorage` after meaningful changes.

The current schema is **version 3**; versions 1 and 2 are migrated on load,
keeping all original ids, by the same code on both sides:

- **1 -> 2** creates the default parts and assigns every existing node and edge
  to one of them.
- **2 -> 3** gives every node a `width` and `brightness`, defaulting to values
  that reproduce the previous fixed node dot, so migrated art renders unchanged.

A player meeting a file from a newer editor refuses it rather than
mis-rendering it.

The reference image's old `locked` flag is dropped on load — the Reference tool
decides when the image moves now — while its transform is preserved. Editor-only
state (part lock/hide/solo/x-ray, selection mode, onion skin, grid and snapping,
colours, reference display) lives under the editor preferences key and never
enters the exported document.

## Tests

```
Model and state
  tests/coordinates.test.ts        coordinate round trips, camera, lasso geometry
  tests/project.test.ts            graph ops, duplicate edges, deletion cascade
  tests/parts.test.ts              parts, membership, lock/hide/solo
  tests/edgeSelection.test.ts      edges following nodes, selection modes
  tests/occluders.test.ts          occluder model, resolution, editing, validation
  tests/poseTiming.test.ts         duration rescaling, even frame distribution
  tests/history.test.ts            undo/redo, drag-as-one-entry, pose isolation
  tests/serialization.test.ts      round trip, import validation
  tests/migration.test.ts          schema 1 -> 2 -> 3 migration

Rendering
  tests/interpolation.test.ts      easing, pose-segment selection, reusable buffers
  tests/animationPlayer.test.ts    the player driven with no store at all
  tests/runtimePackage.test.ts     mount() and <line-bird> as a site meets them
  tests/runtimeBoundary.test.ts    runtime imports nothing from the editor
  tests/interpolationModes.test.ts linear vs Catmull-Rom, loop seam continuity
  tests/nodeAppearance.test.ts     node dot geometry, defaults, store edits
  tests/masking.test.ts            destination-out pixel behaviour (needs node-canvas)

UI
  tests/partsPanel.test.ts         parts panel toggles, driven by real gestures
  tests/inspectorAppearance.test.ts width/brightness for one and many items
  tests/appearanceLive.test.ts     slider drag as a single undo step
  tests/inspectorOccluder.test.ts  leaving the occluder panel
  tests/inspectorReference.test.ts reference name in the section heading
  tests/poseTimeline.test.ts       single vs double tap on a pose name
  tests/playbackScrub.test.ts      pause on scrub, pose selection, snap on release
  tests/projectIdentity.test.ts    project name, export filenames, new project
  tests/topbarMenu.test.ts         top bar menu: grouping, closing, keyboard
  tests/artworkScaling.test.ts     artboard refit on resize, scaling the animation
  tests/imageDrop.test.ts          whole-window image drop

Editor
  tests/referenceTool.test.ts      reference drag, zoom, undo, cancel
  tests/toolPreview.test.ts        tool previews re-projecting on pan/zoom
  tests/layeredFlow.test.ts        end-to-end layered authoring flow
  tests/flow.test.ts               end-to-end authoring flow, 200/500/10 scale check
  tests/mount.test.ts              real app mounted in jsdom
  tests/interaction.test.ts        pointer/keyboard input through the live editor
```

`mount` and `interaction` bring up the real application in jsdom with a
node-canvas backend and drive actual pointer events, so node creation, edge
creation, dragging, marquee selection, deletion, pan/zoom and preview pixel
output are verified rather than assumed. The UI suites mount their real
components in bare jsdom — none of them pull in Konva — and drive them through
the events a browser actually sends, which is the only way to catch bugs where a
re-render replaces the element mid-gesture.

## Known limitations

- `tests/masking.test.ts`, `tests/animationPlayer.test.ts`,
  `tests/runtimePackage.test.ts`, `tests/mount.test.ts`, `tests/interaction.test.ts`
  and `tests/toolPreview.test.ts` need the optional `canvas` native binding,
  because jsdom has no canvas of its own and Konva needs a real 2D context to
  construct a shape. `package.json` allows its install script, so
  `npm install` builds it; where it is unavailable those files skip rather than
  fail, and the rest of the suite is unaffected.
- `node-canvas` does not implement `ctx.filter`, so the blur in
  `glowRenderer.ts` has no automated coverage. The masking tests stand in a
  wide, faint stroke for the blurred halo: they verify that `destination-out`
  clears partial alpha, which is the property that matters, not that the blur
  itself ran.
- Drag and transform clamp stored positions to `[-0.25, 1.25]` rather than a
  hard `[0, 1]`; strict clamping would permanently squash a selection rotated
  near the frame edge. Node *creation* is restricted to `0..1` as specified.
- Pose reordering uses arrow buttons, not drag-and-drop.
- Reference image scaling and opacity are inspector sliders; repositioning is
  the Reference tool (`R`). The image is never a pointer target itself, so a
  drag over it can never mean two things at once.
- The stage uses six Konva layers, above the 3-5 Konva recommends, which logs a
  console warning. Each layer costs a scene canvas and a hit canvas. Four of the
  six are non-listening and could become `Konva.Group`s inside shared layers,
  at the cost of coarser redraw invalidation.
- Background particles, tendrils and shaders are deliberately absent; the
  renderer is layered so they can be added as separate passes.
- Performance targets are met in a headless interpolation benchmark, but frame
  rate at 200 nodes / 500 edges has not been measured in a real browser.
- Preview rendering is covered by unit tests on its pure helpers and by the
  node-canvas pixel tests; the per-frame draw loop that feeds them is verified
  only by typecheck and build.
