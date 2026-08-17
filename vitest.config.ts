import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The job queue and settings tests share one SQLite file per worker; running
    // files in sequence keeps them from tripping over each other.
    fileParallelism: false,
  },
  resolve: {
    alias: { '@': path.resolve(process.cwd()) },
  },
});
