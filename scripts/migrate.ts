import path from 'node:path';
import '../lib/bootstrap-env';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { closeDb, db } from '../lib/db/client';

async function main(): Promise<void> {
  await migrate(db(), { migrationsFolder: path.join(process.cwd(), 'drizzle') });
  console.log('migrations applied');
  await closeDb();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
