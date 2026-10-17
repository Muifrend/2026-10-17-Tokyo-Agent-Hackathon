import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: '.vite/build',
    emptyOutDir: false,
    lib: {
      entry: 'src/main/index.ts',
      formats: ['es'],
      fileName: () => 'main.mjs'
    },
    rollupOptions: {
      external: [/^node:/, 'electron', 'neo4j-driver', 'dotenv', 'zod']
    }
  }
});
