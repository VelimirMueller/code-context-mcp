import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    ignores: [
      'dist/',
      'node_modules/',
      '**/node_modules/',
      '.claude/',
      'docs/',
      'src/dashboard/app/dist/',
      '**/*.min.js',
      '**/*.bundle.js',
    ],
  },
  {
    linterOptions: {
      // Don't error on eslint-disable comments that reference missing rules
      // (e.g. react-hooks/exhaustive-deps from files using inline disables)
      reportUnusedDisableDirectives: 'warn',
    },
    languageOptions: {
      globals: {
        // Node.js globals
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        // Test globals
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
        // Browser globals (for frontend)
        document: 'readonly',
        window: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        HTMLElement: 'readonly',
        EventSource: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        AbortController: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        requestAnimationFrame: 'readonly',
      },
    },
    rules: {
      // Practical defaults — catch real bugs, not style nits
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-expressions': 'warn',
      'no-empty': 'warn',
      'no-useless-assignment': 'warn',
      'no-control-regex': 'warn',
      'prefer-const': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'preserve-caught-error': 'off',
    },
  },
  {
    // #190: the MCP server and the scrum tools have typed rows and bodies; no new any.
    files: ['src/server/**/*.ts', 'src/scrum/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
