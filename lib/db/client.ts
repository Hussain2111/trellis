import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { env } from '../env';
import * as schema from './schema';

export type DB = PostgresJsDatabase<typeof schema>;

let instance: DB | null = null;
let client: ReturnType<typeof postgres> | null = null;

/**
 * One `postgres` client per lambda instance, memoised across invocations of
 * the same warm container. Vercel functions are short-lived and can run many
 * concurrently, so this points at Supabase's connection pooler (port 6543,
 * transaction mode) rather than a direct connection — a direct connection
 * would exhaust Postgres's connection limit under concurrent invocations.
 *
 * `prepare: false` is required in transaction-pooling mode: pgbouncer does not
 * hold a session open long enough for a prepared statement to survive across
 * queries.
 */
export function db(): DB {
  if (instance) return instance;
  client = postgres(env().DATABASE_URL, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  instance = drizzle(client, { schema });
  return instance;
}

/** Escape hatch for the few places that need raw SQL. */
export function sql() {
  db();
  if (!client) throw new Error('database not initialised');
  return client;
}

export async function closeDb(): Promise<void> {
  await client?.end({ timeout: 5 });
  client = null;
  instance = null;
}

export { schema };
