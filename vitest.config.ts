import { defineConfig } from 'vitest/config';

// unit: no services.  db: a real PostgreSQL at TEST_DATABASE_URL (scripts/dev-db.sh).
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], exclude: ['**/*.db.test.ts', '**/node_modules/**'], environment: 'node' } },
      { test: { name: 'db', include: ['src/**/*.db.test.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 60000 } },
    ],
  },
});
