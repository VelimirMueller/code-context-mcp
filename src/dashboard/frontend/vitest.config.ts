import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@bench': path.resolve(__dirname, '../../../scripts/bench/lib'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      include: ['src/**'],
      // Today's level, raised over time toward the fleet floor of lines 80 / branches 70
      // (fleet.yml exception CI-UNIT-03).
      thresholds: { lines: 36, branches: 30 },
    },
  },
});
