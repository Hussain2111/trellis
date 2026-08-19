import { z } from 'zod';
import { createEntry, listEntries } from '@/lib/publish/schedule';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  scheduledFor: z.string().datetime(),
  format: z.enum(['carousel', 'reel', 'image', 'story']).default('image'),
  title: z.string().default(''),
  hook: z.string().nullable().default(null),
  caption: z.string().default(''),
  hashtags: z.array(z.string()).default([]),
  notes: z.string().nullable().default(null),
  mediaUrls: z.array(z.string().url()).default([]),
});

export async function GET(): Promise<Response> {
  return Response.json({ rows: await listEntries() });
}

/**
 * Creates a calendar entry. v2 entries are hand-written, so everything the
 * post needs is in the body — there is no draft to point at. Whether it
 * actually goes out on its own is a separate question, gated by
 * ENABLE_IG_PUBLISHING — see lib/jobs/handlers/publish-due.ts.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }
  const { scheduledFor, ...rest } = parsed.data;
  const id = await createEntry({ ...rest, scheduledFor: new Date(scheduledFor) });
  return Response.json({ id });
}
