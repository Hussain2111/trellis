import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { closeDb, db } from '@/lib/db/client';
import { __setEnvForTests, envSchema } from '@/lib/env';

let dir: string | null = null;

/** A throwaway migrated database per test file. */
export function useTempDb(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-test-'));
  process.env.DATABASE_PATH = path.join(dir, 'test.db');
  closeDb();
  migrate(db(), { migrationsFolder: path.join(process.cwd(), 'drizzle') });
}

export function dropTempDb(): void {
  closeDb();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
}

export function setEnv(overrides: Record<string, unknown> = {}): void {
  __setEnvForTests(envSchema.parse({ NODE_ENV: 'test', ...overrides }));
}
