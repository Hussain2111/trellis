import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Several test files share one real Postgres database (there's no
    // per-file sandbox the way an in-memory DB would give you), so running
    // files in parallel lets one file's afterEach cleanup race another
    // file's assertions. Sequential keeps them from tripping over each other.
    fileParallelism: false,
  },
  resolve: {
    alias: { '@': path.resolve(process.cwd()) },
  },
});
