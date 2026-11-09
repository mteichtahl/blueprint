#!/usr/bin/env node
// `blueprint` launcher: runs the TypeScript CLI through tsx, from any folder.
import { register } from 'tsx/esm/api';

register();
await import('../src/index.ts');
