import { z } from 'zod';
import { generateOpportunities, generateWeekly } from '@/lib/generate/run';
import {
  REGENERATE_DAILY_CAP,
  recordRegenerationAttempt,
  regenerationsToday,
} from '@/lib/generate/store';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ kind: z.enum(['opportunities', 'weekly']) });

/**
 * Manual regeneration for the current week. The only path that calls a model
 * outside the weekly cron, and it is capped: page loads read cache, and an
 * unbounded button would put the Gemini free-tier limit one impatient click
 * away.
 *
 * The attempt is recorded before the call, not after, so a run that fails
 * still counts against the cap — otherwise a loop of failures runs free.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }
  const { kind } = parsed.data;

  const used = await regenerationsToday(kind);
  if (used >= REGENERATE_DAILY_CAP) {
    return Response.json(
      {
        error: `Regeneration is capped at ${REGENERATE_DAILY_CAP} a day for ${kind} and you have used ${used}. The weekly cron will refresh it regardless.`,
      },
      { status: 429 },
    );
  }

  await recordRegenerationAttempt(kind);
  const outcome = kind === 'opportunities' ? await generateOpportunities() : await generateWeekly();

  return Response.json({
    ...outcome,
    regenerationsUsed: used + 1,
    regenerationCap: REGENERATE_DAILY_CAP,
  });
}
