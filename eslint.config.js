import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import betterTailwind from 'eslint-plugin-better-tailwindcss';

const FRONTEND = 'src/dashboard/frontend/src';

// #293 ratchet: files that still carry static inline styles. A slice that moves a
// file to Tailwind removes it here; a new file never joins the list.
export const LEGACY_INLINE_STYLE = [
  'App.tsx',
  'components/molecules/AlertDialog.tsx',
  'components/molecules/Breadcrumb.tsx',
  'components/molecules/FileItem.tsx',
  'components/molecules/FolderItem.tsx',
  'components/molecules/SearchBar.tsx',
  'components/molecules/StatGroup.tsx',
  'components/molecules/SubTabBar.tsx',
  'components/molecules/TabBar.tsx',
  'components/molecules/WizardModal.tsx',
  'components/organisms/BentoGrid.tsx',
  'components/organisms/BurndownChart.tsx',
  'components/organisms/DashboardTour.tsx',
  'components/organisms/DependencyGraph.tsx',
  'components/organisms/EpicList.tsx',
  'components/organisms/FileTree.tsx',
  'components/organisms/KanbanBoard.tsx',
  'components/organisms/LandingAnimation.tsx',
  'components/organisms/SprintCompletionPanel.tsx',
  'components/organisms/SprintDetail.tsx',
  'components/organisms/SprintList.tsx',
  'components/organisms/TeamGrid.tsx',
  'components/organisms/TeamManagementModal.tsx',
  'components/organisms/TicketDetailModal.tsx',
  'pages/Benchmark.tsx',
  'pages/CodeExplorer.tsx',
  'pages/Dashboard.tsx',
  'pages/ProjectManagement.tsx',
  'pages/Retro.tsx',
  'pages/Team.tsx',
];

// #293: class names the Tailwind config does not know: global classes in src/index.css and
// names styled only in the legacy dashboard.html (they render unstyled in the Vite app).
// A slice that removes a name removes it here.
export const LEGACY_CLASSES = [
  '^action-count$',
  '^action-icon$',
  '^action-label$',
  '^active$',
  '^app$',
  '^breadcrumb$',
  '^breadcrumb-current$',
  '^breadcrumb-item$',
  '^breadcrumb-link$',
  '^breadcrumb-separator$',
  '^breadcrumb-text$',
  '^change-event$',
  '^change-header$',
  '^change-item$',
  '^chevron$',
  '^count$',
  '^dep-item$',
  '^dep-path$',
  '^dep-symbols$',
  '^detail-desc$',
  '^detail-meta$',
  '^detail-section$',
  '^detail-title$',
  '^empty$',
  '^empty-icon$',
  '^file-item$',
  '^file-name$',
  '^file-size$',
  '^folder-count$',
  '^folder-icon$',
  '^folder-name$',
  '^highlight$',
  '^kbd-hint$',
  '^logo$',
  '^logo-icon$',
  '^logo-sub$',
  '^logo-text$',
  '^main$',
  '^open$',
  '^page-content$',
  '^quick-action-btn$',
  '^quick-actions-bar$',
  '^quick-actions-breadcrumb$',
  '^quick-actions-buttons$',
  '^quick-search$',
  '^search$',
  '^search-input$',
  '^search-wrap$',
  '^sidebar$',
  '^sidebar-body$',
  '^sidebar-head$',
  '^stats$',
  '^tab$',
  '^tabs$',
  '^top-nav$',
  '^top-nav-icon$',
  '^top-nav-item$',
  '^top-nav-label$',
  '^topbar$',
  '^tree-children$',
  '^tree-folder$',
  '^tree-folder-head$',
];

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
      'src/dashboard/frontend/dist/',
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
    // #293: the dashboard styles with Tailwind utilities and tokens (src/index.css @theme).
    // `style` keeps only runtime values (widths, positions, framer-motion values) and
    // CSS variables fed from data (`style={{ '--c': epic.color }}` + `bg-(--c)`).
    // The rule sees literal values only; a constant or a spread still passes, so review those.
    files: [`${FRONTEND}/**/*.tsx`],
    ignores: LEGACY_INLINE_STYLE.map((f) => `${FRONTEND}/${f}`),
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute[name.name='style'] > JSXExpressionContainer > ObjectExpression > Property:not([key.value=/^--/])[value.type=/^(Literal|TemplateLiteral)$/]",
          message:
            'Static style value: use a Tailwind utility with a token from src/index.css (#293).',
        },
        {
          selector:
            "AssignmentExpression > MemberExpression.left[object.property.name='style'][object.object.property.name='currentTarget']",
          message: 'Hover style in a handler: use a `hover:` utility (#293).',
        },
      ],
    },
  },
  {
    files: [`${FRONTEND}/**/*.tsx`],
    plugins: { 'better-tailwindcss': betterTailwind },
    settings: { 'better-tailwindcss': { entryPoint: `${FRONTEND}/index.css` } },
    rules: {
      // A typo or an old name (`text-text2`) produces no CSS and fails silently.
      'better-tailwindcss/no-unknown-classes': ['error', { ignore: LEGACY_CLASSES }],
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
