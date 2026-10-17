import { defineConfig } from 'vite';

// Sandboxed preload must be a single CJS file with no external imports
// beyond `electron`.
export default defineConfig({
  build: {
    outDir: '.vite/build',
    emptyOutDir: false,
    lib: {
      entry: 'src/preload.ts',
      formats: ['cjs'],
      fileName: () => 'preload.js'
    },
    rollupOptions: {
      external: ['electron'],
      output: {
        inlineDynamicImports: true
      }
    }
  }
});
