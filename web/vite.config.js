import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The daemon serves the built output itself (see src/http/static.ts):
// - GET /          -> dist/index.html with the API token injected
// - GET /assets/*  -> hashed static files
//
// In dev mode, `pnpm dev` proxies /api and /healthz to the local daemon
// (start it with `node dist/src/cli/index.js server --foreground`).
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7800',
      '/healthz': 'http://127.0.0.1:7800',
    },
  },
});
