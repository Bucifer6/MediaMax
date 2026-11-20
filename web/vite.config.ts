import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const target = process.env.MEDIAMAX_SERVER ?? 'http://localhost:8484';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // jassub imports this requestVideoFrameCallback polyfill (GPL-3.0) for a side effect only. jassub works without it
      // (it renders on timeupdate when rVFC is missing), so we don't ship it: keeps the bundle MIT/LGPL-compatible.
      'rvfc-polyfill': fileURLToPath(new URL('./src/player/subtitles/rvfc-stub.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true, ws: true },
    },
  },
  preview: {
    proxy: {
      '/api': { target, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
