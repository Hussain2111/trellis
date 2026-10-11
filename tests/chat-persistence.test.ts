import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, closeDb } from '../lib/db/client';
import { accounts, modelRuns } from '../lib/db/schema';
import {
  appendChatTurn,
  createThread,
  findThread,
  ledgerFor,
  threadMessages,
} from '../lib/chat/threads';

let accountId: number;
beforeEach(async () => {
  await db().execute(sql`truncate accounts restart identity cascade`);
  const [account] = await db()
    .insert(accounts)
    .values({ igUserId: 'test', handle: 'test' })
    .returning();
  accountId = account!.id;
});
afterAll(closeDb);

describe('completed chat turn persistence', () => {
  it('stores the question before the answer and preserves a pre-existing title', async () => {
    const thread = await createThread(accountId);
    await appendChatTurn({
      threadId: thread.id,
      question: 'Highest reach?',
      answer: '1248 accounts reached.',
      toolCalls: ['getPostsRanked'],
      validation: null,
    });
    await appendChatTurn({
      threadId: thread.id,
      question: 'What about saves?',
      answer: 'Please choose a period.',
      toolCalls: [],
      validation: null,
    });
    expect((await threadMessages(thread.id)).map((m) => [m.role, m.content])).toEqual([
      ['user', 'Highest reach?'],
      ['assistant', '1248 accounts reached.'],
      ['user', 'What about saves?'],
      ['assistant', 'Please choose a period.'],
    ]);
    expect((await findThread(accountId, thread.id))?.title).toBe('Highest reach?');
  });

  it('rolls back both messages if the thread update fails after insertion', async () => {
    const thread = await createThread(accountId);
    // Local disposable DB only. Trigger failure after the message insert.
    await db().execute(
      sql`create function fail_chat_update() returns trigger language plpgsql as $$ begin raise exception 'test rollback'; end; $$`,
    );
    await db().execute(
      sql`create trigger fail_chat_update before update on chat_threads for each row execute function fail_chat_update()`,
    );
    try {
      await expect(
        appendChatTurn({
          threadId: thread.id,
          question: 'Highest reach?',
          answer: 'An answer.',
          toolCalls: [],
          validation: null,
        }),
      ).rejects.toThrow();
      expect(await threadMessages(thread.id)).toEqual([]);
    } finally {
      await db().execute(sql`drop trigger fail_chat_update on chat_threads`);
      await db().execute(sql`drop function fail_chat_update()`);
    }
  });

  it('counts failed Gemini calls independently of successful Groq calls', async () => {
    await db()
      .insert(modelRuns)
      .values([
        {
          accountId,
          purpose: 'chat',
          provider: 'google',
          model: 'test',
          status: 'error',
          calls: 4,
        },
        { accountId, purpose: 'chat', provider: 'groq', model: 'test', status: 'ok', calls: 2 },
      ]);
    expect(await ledgerFor('google').callsToday('chat')).toBe(4);
    expect(await ledgerFor('groq').callsToday('chat')).toBe(2);
    expect(await ledgerFor('google').callsLastMinute()).toBe(4);
    expect(await ledgerFor('groq').callsLastMinute()).toBe(2);
  });
});
