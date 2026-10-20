import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: __dirname,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // CCA-20: the bench verdict rule (pure, no imports) is shared with scripts/bench.
      '@bench': path.resolve(__dirname, '../../../scripts/bench/lib'),
    },
  },
  server: {
    // The dev server may serve the shared verdict module from outside the app root.
    fs: {
      allow: [
        searchForWorkspaceRoot(__dirname),
        path.resolve(__dirname, '../../../scripts/bench/lib/verdict.mts'),
      ],
    },
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.VITE_DASHBOARD_PORT ?? '3333'}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../../../dist/dashboard'),
    emptyOutDir: false,
  },
});
