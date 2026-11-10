import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/cdk.out/**',
      '**/.agent-build/**',
      '**/node_modules/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    // Node scripts for the staging scans and load test (Phase 6).
    files: ['tools/**/*.mjs'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
);
