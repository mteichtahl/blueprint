import { defineConfig } from 'vitest/config';

// Synthesizing the whole app (with esbuild bundling) takes several seconds.
export default defineConfig({ test: { testTimeout: 60_000 } });
