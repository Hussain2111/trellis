import { z } from 'zod';
import { markPosted, unschedule } from '@/lib/publish/schedule';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({ action: z.literal('mark_posted') });

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  await unschedule(Number(id));
  return Response.json({ ok: true });
}

/** Manual-publish confirmation — the path used when ENABLE_IG_PUBLISHING is off. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }
  await markPosted(Number(id));
  return Response.json({ ok: true });
}
