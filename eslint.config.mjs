import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import maak from './packages/config/eslint-plugin-maak/index.js';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      'supabase/functions/_bundled/**',
      // Local dev backend artefacts (PostgreSQL cluster, esbuild bundle of @maak/core).
      '.dev/**',
      'package-lock.json',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: { maak },
    rules: {
      // Architecture rules — the reason this codebase stays maintainable.
      'maak/core-is-framework-free': 'error',
      'maak/no-physical-direction': 'error',
      'maak/no-hardcoded-copy': 'error',
      'maak/single-write-per-handler': 'error',

      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },

  {
    // Edge functions run on Deno: globals and npm: specifiers are legitimate there.
    files: ['supabase/functions/**/*.ts'],
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  {
    files: ['scripts/**/*.mjs', '**/*.config.{js,mjs,ts}', 'packages/config/**/*.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Deno: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    files: ['**/*.test.ts', 'packages/core/tests/**/*.ts'],
    rules: {
      'maak/no-hardcoded-copy': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
