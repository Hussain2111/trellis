import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type DB = BetterSQLite3Database<typeof schema>;

let instance: DB | null = null;
let raw: Database.Database | null = null;

function resolveDbPath(): string {
  const p = process.env.DATABASE_PATH ?? './data/app.db';
  // The bundler can't statically scope a configurable path and would otherwise
  // trace the whole project into the server output. This app only ever runs
  // locally, so the trace is pointless here.
  return path.isAbsolute(p) ? p : path.join(/* turbopackIgnore: true */ process.cwd(), p);
}

/**
 * One connection per process. The web app and the worker are separate
 * processes hitting the same file, so WAL + a busy timeout are what keep them
 * from tripping over each other.
 */
export function db(): DB {
  if (instance) return instance;
  const file = resolveDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  raw = new Database(file);
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');

  instance = drizzle(raw, { schema });
  return instance;
}

/** Escape hatch for the few places that need raw SQL (atomic job claims). */
export function sqlite(): Database.Database {
  db();
  if (!raw) throw new Error('database not initialised');
  return raw;
}

export function closeDb(): void {
  raw?.close();
  raw = null;
  instance = null;
}

export { schema };
