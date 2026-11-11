import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// Relative import: the config is bundled, so the shared TS module needs no build step.
import { buildRelease } from '../../packages/config/src/release.ts';

// Release label and notes, from VERSION and CHANGELOG.md. The deploy workflows
// sets BMG_ENV (staging → beta-X.Y.Z, prod → X.Y.Z); anything else is dev-X.Y.Z.
const release = buildRelease(
  resolve(import.meta.dirname, '../..'),
  process.env.BMG_ENV,
  process.env.BMG_VERSION ?? process.env.GITHUB_SHA,
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __BMG_RELEASE__: JSON.stringify(release) },
  build: { outDir: 'dist', sourcemap: false, emptyOutDir: true },
  server: {
    port: 5173,
    // Local development against staging: `BMG_API=https://<staging web url> npm run dev -w @bmg/web`
    proxy: process.env.BMG_API
      ? { '/v1': { target: process.env.BMG_API, changeOrigin: true } }
      : {},
  },
});
