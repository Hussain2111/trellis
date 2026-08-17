import path from 'node:path';
import '../lib/bootstrap-env';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { closeDb, db } from '../lib/db/client';

migrate(db(), { migrationsFolder: path.join(process.cwd(), 'drizzle') });
console.log('migrations applied →', process.env.DATABASE_PATH ?? './data/app.db');
closeDb();
