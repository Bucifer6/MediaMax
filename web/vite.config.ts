import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Writes .br and .gz next to every compressible build asset; the server sends them to clients that accept them
 * (@fastify/static preCompressed). On a TV over Wi-Fi the first load is mostly bytes on the wire.
 */
function precompress(): Plugin {
  let outDir = 'dist';
  return {
    name: 'mediamax-precompress',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
      for (const f of walk(path.join(outDir, 'assets'))) {
        if (!/\.(js|mjs|css|svg|json|wasm|woff|ttf|txt)$/i.test(f)) continue;
        const buf = fs.readFileSync(f);
        if (buf.length < 1024) continue;
        const br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
        const gz = zlib.gzipSync(buf, { level: 9 });
        if (br.length < buf.length * 0.9) fs.writeFileSync(f + '.br', br);
        if (gz.length < buf.length * 0.9) fs.writeFileSync(f + '.gz', gz);
      }
    },
  };
}
import { serviceWorker } from './sw/plugin';

const target = process.env.MEDIAMAX_SERVER ?? 'http://localhost:8484';

export default defineConfig({
  plugins: [react(), precompress(), serviceWorker()],
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
