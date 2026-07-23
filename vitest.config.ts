import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    minWorkers: 1,
    maxWorkers: 2,
  },
  css: false,
});
