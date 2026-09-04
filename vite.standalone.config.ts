import { defineConfig } from 'vite';

/**
 * The single-file build, alongside the split one.
 *
 * Code splitting off leaves no chunks to resolve, so the result is one
 * module with no imports of its own — droppable into an `assets/` folder and
 * loadable by a `<script type="module">` with no bundler, import map or CDN
 * anywhere in the picture. It writes into the same `dist/runtime` folder the
 * package ships, so it must run *after* the split build, which empties it.
 */
export default defineConfig({
  publicDir: false,
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist/runtime',
    emptyOutDir: false,
    lib: {
      entry: { 'line-bird.standalone': 'src/runtime/standalone.ts' },
      formats: ['es'],
    },
    rollupOptions: {
      output: { entryFileNames: '[name].js', codeSplitting: false },
    },
  },
});
