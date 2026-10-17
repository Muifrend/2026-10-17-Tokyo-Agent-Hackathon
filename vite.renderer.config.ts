import { defineConfig } from 'vite';
import path from 'node:path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), {
    name:'dev-csp',
    transformIndexHtml(html,ctx) {
      return ctx.server ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("default-src 'self';", "default-src 'self'; connect-src 'self' ws://localhost:* ws://127.0.0.1:*;") : html;
    }
  }],
  base: './',
  build: {
    outDir: path.resolve('.vite/renderer/main_window'),
    emptyOutDir: true
  }
});
