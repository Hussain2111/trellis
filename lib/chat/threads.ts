import { asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { accounts, chatMessages, chatThreads, posts } from '../db/schema';
import { renderChatSystem } from '../prompts/chat-system.v1';
import { latestAnalysis, topPattern } from '../analysis/analysis';
import { selfAccount } from '../ingest/upsert';

export async function listThreads() {
  return db().select().from(chatThreads).orderBy(desc(chatThreads.updatedAt));
}

export async function createThread(title = 'New thread'): Promise<number> {
  const [row] = await db().insert(chatThreads).values({ title }).returning({ id: chatThreads.id });
  return row!.id;
}

export async function threadMessages(threadId: number) {
  return db()
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.id));
}

export async function appendMessage(input: {
  threadId: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: unknown;
  generatedBy?: string;
}): Promise<void> {
  await db()
    .insert(chatMessages)
    .values({
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      toolCalls: input.toolCalls ?? null,
      generatedBy: input.generatedBy ?? null,
    });
  await db()
    .update(chatThreads)
    .set({ updatedAt: new Date() })
    .where(eq(chatThreads.id, input.threadId));
}

/** First user message becomes the thread title — nobody names their own threads. */
export async function titleThread(threadId: number, firstMessage: string): Promise<void> {
  const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!title) return;
  await db().update(chatThreads).set({ title }).where(eq(chatThreads.id, threadId));
}

/** Summary + top pattern + date. Never the corpus — tools fetch that on demand. */
export async function buildSystemPrompt(): Promise<string> {
  const self = await selfAccount();
  const analysis = await latestAnalysis();
  const pattern = analysis ? topPattern(analysis) : null;

  const postCount = self
    ? ((
        await db().execute<{ n: number }>(
          sql`select count(*)::int as n from ${posts} where account_id = ${self.id}`,
        )
      )[0]?.n ?? 0)
    : 0;

  const competitorCount =
    (
      await db().execute<{ n: number }>(
        sql`select count(*)::int as n from ${accounts} where role = 'competitor'`,
      )
    )[0]?.n ?? 0;

  return renderChatSystem({
    handle: self?.handle ?? 'unknown',
    niche: self?.niche ?? null,
    followers: self?.followers ?? null,
    postCount,
    competitorCount,
    topPatternClaim: pattern ? pattern.claim : null,
    today: new Date().toISOString().slice(0, 10),
  });
}

export async function deleteThread(threadId: number): Promise<void> {
  await db().delete(chatThreads).where(eq(chatThreads.id, threadId));
}
