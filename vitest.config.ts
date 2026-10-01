import { defineConfig } from 'vitest/config';

// unit: no services.  db: a real PostgreSQL at TEST_DATABASE_URL (scripts/dev-db.sh).  rabbit: db + RabbitMQ.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], exclude: ['**/*.db.test.ts', '**/*.rabbit.test.ts', '**/node_modules/**'], environment: 'node' } },
      { test: { name: 'db', include: ['src/**/*.db.test.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 60000 } },
      // Also needs TEST_AMQP_URL (scripts/dev-rabbit.sh).
      { test: { name: 'rabbit', include: ['src/**/*.rabbit.test.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 60000 } },
    ],
  },
});
