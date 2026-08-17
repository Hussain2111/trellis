import { z } from 'zod';
import { scheduleDraft, scheduledRows } from '@/lib/publish/schedule';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  draftId: z.number().int(),
  scheduledFor: z.string().datetime(),
});

export async function GET(): Promise<Response> {
  return Response.json({ rows: await scheduledRows() });
}

/** Schedules a draft. Whether it actually goes out on its own is a separate
 * question, gated by ENABLE_IG_PUBLISHING — see lib/jobs/handlers/publish-due.ts. */
export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }
  const id = await scheduleDraft(parsed.data.draftId, new Date(parsed.data.scheduledFor));
  return Response.json({ id });
}
