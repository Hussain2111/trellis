import { z } from 'zod';
import { deleteEntry, markPosted, updateEntry } from '@/lib/publish/schedule';

export const dynamic = 'force-dynamic';

const patchSchema = z.union([
  z.object({ action: z.literal('mark_posted') }),
  z.object({
    action: z.literal('update'),
    scheduledFor: z.string().datetime().optional(),
    format: z.enum(['carousel', 'reel', 'image', 'story']).optional(),
    title: z.string().optional(),
    hook: z.string().nullable().optional(),
    caption: z.string().optional(),
    hashtags: z.array(z.string()).optional(),
    notes: z.string().nullable().optional(),
    mediaUrls: z.array(z.string().url()).optional(),
  }),
]);

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  await deleteEntry(Number(id));
  return Response.json({ ok: true });
}

/** `mark_posted` is the path used when ENABLE_IG_PUBLISHING is off — the user
 * posted it by hand and is recording that. `update` edits the entry itself. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  if (parsed.data.action === 'mark_posted') {
    await markPosted(Number(id));
    return Response.json({ ok: true });
  }

  const { scheduledFor, ...rest } = parsed.data;
  delete (rest as { action?: unknown }).action;
  await updateEntry(Number(id), {
    ...rest,
    ...(scheduledFor ? { scheduledFor: new Date(scheduledFor) } : {}),
  });
  return Response.json({ ok: true });
}
