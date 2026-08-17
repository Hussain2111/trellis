import { createThread, listThreads } from '@/lib/chat/threads';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json({ threads: await listThreads() });
}

export async function POST(): Promise<Response> {
  const id = await createThread();
  return Response.json({ id });
}
