import path from 'node:path';
import { config } from 'dotenv';

/**
 * Next loads `.env.local` for us; plain Node scripts (worker, benchmark,
 * migrate) do not. Import this first in any script entrypoint. Same precedence
 * as Next: `.env.local` wins over `.env`.
 */
config({ path: path.join(process.cwd(), '.env.local'), quiet: true });
config({ path: path.join(process.cwd(), '.env'), quiet: true });
