import { deleteThread } from '@/lib/chat/threads';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  await deleteThread(Number(id));
  return Response.json({ ok: true });
}
