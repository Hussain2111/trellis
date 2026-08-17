import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client';
import { posts, voiceProfile as voiceTable } from '../db/schema';
import { renderVoiceForPrompt, type VoiceFields } from '../prompts/voice-profile.v1';
import { selfAccount } from '../ingest/upsert';

export interface ActiveVoice {
  id: number;
  version: number;
  markdown: string;
  fields: VoiceFields;
  generatedBy: string;
}

export async function activeVoice(): Promise<ActiveVoice | null> {
  const [row] = await db()
    .select()
    .from(voiceTable)
    .where(eq(voiceTable.active, true))
    .orderBy(desc(voiceTable.version))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    markdown: row.markdown,
    fields: row.fields as VoiceFields,
    generatedBy: row.generatedBy,
  };
}

/** Store a new version. Versions are never overwritten — a regeneration you dislike should be a revert, not a loss. */
export async function saveVoice(input: {
  markdown: string;
  fields: VoiceFields;
  generatedBy: string;
}): Promise<number> {
  const [latest] = await db()
    .select({ version: voiceTable.version })
    .from(voiceTable)
    .orderBy(desc(voiceTable.version))
    .limit(1);
  const version = (latest?.version ?? 0) + 1;

  return db().transaction(async (tx) => {
    await tx.update(voiceTable).set({ active: false }).where(eq(voiceTable.active, true));
    const [row] = await tx
      .insert(voiceTable)
      .values({
        version,
        markdown: input.markdown,
        fields: input.fields,
        active: true,
        generatedBy: input.generatedBy,
      })
      .returning({ id: voiceTable.id });
    return row!.id;
  });
}

/** The compact block injected into generation prompts. */
export async function voiceBlock(): Promise<string> {
  const voice = await activeVoice();
  if (!voice)
    return 'VOICE — no profile yet. Write plainly and specifically; avoid marketing register.';
  return renderVoiceForPrompt(voice.fields);
}

/** My best captions, which is all the voice profile needs to see. */
export async function topCaptionsForVoice(limit: number): Promise<string[]> {
  const self = await selfAccount();
  if (!self) return [];
  const rows = await db()
    .select({ caption: posts.caption })
    .from(posts)
    .where(and(eq(posts.accountId, self.id), isNotNull(posts.caption)))
    .orderBy(desc(posts.likes))
    .limit(limit);
  return rows.map((r) => r.caption ?? '').filter((c) => c.trim().length > 40);
}
