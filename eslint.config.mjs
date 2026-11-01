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
    // k6 scripts are not modules in a browser or in Node: the k6 runtime injects `__ENV` and `__VU`, and the
    // `k6/*` imports only resolve when k6 runs them. Linting them as page code would be checking a language
    // they are not written in — but leaving them unlinted would let a real mistake (a typo in a threshold
    // name, an unused import) through, so only the environment is relaxed.
    files: ['docs/perf/*.js'],
    languageOptions: {
      globals: {
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
      },
    },
  },

  {
    // Node scripts that talk to the network use the WHATWG fetch API's abort pair. They exist in Node 18+
    // (`node:globals` does not list the DOM's AbortController under that name in this config), and the rest of
    // the file is linted as usual so a typo is still caught.
    files: ['scripts/*.mjs'],
    languageOptions: {
      globals: {
        AbortController: 'readonly',
        clearTimeout: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },

  {
    // The service worker is not a module in a page: it has no `window` and does have `self`. Browsers run
    // it in a worker scope, so the rules that guess a browser environment are wrong here.
    files: ['apps/web/public/**/*.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
      },
    },
    rules: { 'no-undef': 'off' },
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
        URLSearchParams: 'readonly',
        FormData: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
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
