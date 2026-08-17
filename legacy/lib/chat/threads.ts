import { asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { accounts, chatMessages, chatThreads, posts } from '../db/schema';
import { renderChatSystem } from '../prompts/chat-system.v1';
import { latestAnalysis } from '../jobs/handlers/analysis';
import { voiceBlock } from '../analysis/voice';
import { selfAccount } from '../ingest/upsert';
import { getSettings } from '../settings';
import { sql } from 'drizzle-orm';
import type { Gap } from '../prompts/gap-analysis.v1';

const nowS = (): number => Math.floor(Date.now() / 1000);

export function listThreads() {
  return db().select().from(chatThreads).orderBy(desc(chatThreads.updatedAt)).all();
}

export function createThread(title = 'New thread'): number {
  return db().insert(chatThreads).values({ title }).returning({ id: chatThreads.id }).get().id;
}

export function threadMessages(threadId: number) {
  return db()
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.id))
    .all();
}

export function appendMessage(input: {
  threadId: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: unknown;
  generatedBy?: string;
}): void {
  db()
    .insert(chatMessages)
    .values({
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      toolCalls: input.toolCalls ?? null,
      generatedBy: input.generatedBy ?? null,
    })
    .run();
  db().update(chatThreads).set({ updatedAt: nowS() }).where(eq(chatThreads.id, input.threadId)).run();
}

/** First user message becomes the thread title — nobody names their own threads. */
export function titleThread(threadId: number, firstMessage: string): void {
  const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!title) return;
  db().update(chatThreads).set({ title }).where(eq(chatThreads.id, threadId)).run();
}

/** Summary + gap + voice + date. Never the corpus — tools fetch that on demand. */
export function buildSystemPrompt(): string {
  const self = selfAccount();
  const settings = getSettings();
  const analysis = latestAnalysis();
  const gap = analysis ? (analysis.gap as Gap) : null;

  const postCount = self
    ? db()
        .select({ n: sql<number>`count(*)` })
        .from(posts)
        .where(eq(posts.accountId, self.id))
        .get()?.n ?? 0
    : 0;

  const competitorCount = db()
    .select({ n: sql<number>`count(*)` })
    .from(accounts)
    .where(eq(accounts.role, 'competitor'))
    .get()?.n ?? 0;

  return renderChatSystem({
    handle: self?.handle ?? 'unknown',
    niche: settings.niche,
    followers: self?.followers ?? null,
    postCount: Number(postCount),
    competitorCount: Number(competitorCount),
    gap: gap ? `${gap.claim} — ${gap.niche_stat} vs ${gap.my_stat} (${gap.delta}). ${gap.why_this_one}` : null,
    voice: voiceBlock(),
    today: new Date().toISOString().slice(0, 10),
  });
}

export function deleteThread(threadId: number): void {
  db().delete(chatThreads).where(eq(chatThreads.id, threadId)).run();
}
