import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', sourcemap: false, emptyOutDir: true },
  server: {
    port: 5173,
    // Local development against staging: `BMG_API=https://<staging web url> npm run dev -w @bmg/web`
    proxy: process.env.BMG_API
      ? { '/v1': { target: process.env.BMG_API, changeOrigin: true } }
      : {},
  },
});
