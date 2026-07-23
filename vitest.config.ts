import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    poolMatchGlobs: [
      ['test/db.test.ts', 'threads'],
      ['test/dual-horizon-db.test.ts', 'threads'],
      ['test/event-backtest-db.test.ts', 'threads'],
      ['test/ingest-db.test.ts', 'threads'],
      ['test/pit-db.test.ts', 'threads'],
      ['test/pit-snapshot-db.test.ts', 'threads'],
      ['test/policy-regime-db.test.ts', 'threads'],
    ],
    poolOptions: {
      threads: { minThreads: 1, maxThreads: 2 },
    },
  },
  css: false,
});
