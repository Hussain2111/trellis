import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { settings } from '@/lib/db/schema';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';

/**
 * Free Supabase projects pause after 7 days with no database activity and
 * take ~30s to wake back up. This does a real write, not just a ping, so it
 * counts as activity — a dashboard visit to the Supabase console does not.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const rows = await db().execute<{ n: number }>(sql`select count(*)::int as n from ${settings}`);
  const n = rows[0]?.n ?? 0;

  await db()
    .insert(settings)
    .values({ key: 'keepalive.last_run', value: { at: new Date().toISOString() } })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: { at: new Date().toISOString() }, updatedAt: new Date() },
    });

  return Response.json({
    ok: true,
    settingsRowCount: n,
    durationMs: Date.now() - startedAt,
  });
}
