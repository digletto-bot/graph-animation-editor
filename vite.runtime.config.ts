import { defineConfig } from 'vite';

/**
 * Builds the embeddable player, separately from the editor app.
 *
 * ES modules only: every target that can run a canvas animation can load one,
 * bundlers can tree-shake it, and a page with no build step reaches it through
 * `<script type="module">`. The three entries stay separate files so a site
 * that trusts its own documents never downloads the validator, and importing
 * the player never registers a custom element.
 */
export default defineConfig({
  // The editor's /public assets (favicons, manifest) belong to the app, not to
  // a package someone installs.
  publicDir: false,
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist/runtime',
    // Wipes the folder, so the declaration emit has to follow this build, not
    // precede it. See the build:runtime script.
    emptyOutDir: true,
    lib: {
      entry: {
        'line-bird': 'src/runtime/index.ts',
        validate: 'src/runtime/validate.ts',
        element: 'src/runtime/element.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
