import type { BuildRelease } from '../../../packages/config/src/release.ts';

declare global {
  /** Injected by vite.config.ts from VERSION and CHANGELOG.md. */
  const __BMG_RELEASE__: BuildRelease;
}
