import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: `pnpm dev` (server on 3100) + `pnpm dev:web` (Vite on 5173, proxying /api and /mcp).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/web', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:3100', changeOrigin: true }, '/mcp': { target: 'http://127.0.0.1:3100', changeOrigin: true } },
  },
});
