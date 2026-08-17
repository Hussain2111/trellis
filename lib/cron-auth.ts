import { env } from './env';

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on invocations it
 * triggers itself when CRON_SECRET is set as a project env var. There is no
 * other auth in this app — see AGENTS.md — so this is the only thing standing
 * between a cron-only endpoint and the public internet.
 */
export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = env().CRON_SECRET;
  if (!secret) return true; // local dev with no secret configured
  return request.headers.get('authorization') === `Bearer ${secret}`;
}
