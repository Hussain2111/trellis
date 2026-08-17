import { desc, eq, isNotNull, and } from 'drizzle-orm';
import { db } from '../db/client';
import { posts, voiceProfile as voiceTable } from '../db/schema';
import { renderVoiceForPrompt, type VoiceFields } from '../prompts/voice-profile.v1';
import { selfAccount } from '../ingest/upsert';

export interface ActiveVoice {
  id: number;
  version: number;
  markdown: string;
  fields: VoiceFields;
  editedByUser: boolean;
  generatedBy: string;
}

export function activeVoice(): ActiveVoice | null {
  const row = db()
    .select()
    .from(voiceTable)
    .where(eq(voiceTable.active, true))
    .orderBy(desc(voiceTable.version))
    .limit(1)
    .get();
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    markdown: row.markdown,
    fields: row.fields as VoiceFields,
    editedByUser: row.editedByUser,
    generatedBy: row.generatedBy,
  };
}

export function voiceVersions() {
  return db().select().from(voiceTable).orderBy(desc(voiceTable.version)).all();
}

/**
 * Store a new version. Versions are never overwritten — a regeneration you
 * dislike should be a revert, not a loss.
 */
export function saveVoice(input: {
  markdown: string;
  fields: VoiceFields;
  generatedBy: string;
  editedByUser: boolean;
}): number {
  const latest = db()
    .select({ version: voiceTable.version })
    .from(voiceTable)
    .orderBy(desc(voiceTable.version))
    .limit(1)
    .get();
  const version = (latest?.version ?? 0) + 1;

  db().update(voiceTable).set({ active: false }).where(eq(voiceTable.active, true)).run();
  const row = db()
    .insert(voiceTable)
    .values({
      version,
      markdown: input.markdown,
      fields: input.fields,
      editedByUser: input.editedByUser,
      active: true,
      generatedBy: input.generatedBy,
    })
    .returning({ id: voiceTable.id })
    .get();
  return row.id;
}

export function activateVoiceVersion(id: number): void {
  db().update(voiceTable).set({ active: false }).where(eq(voiceTable.active, true)).run();
  db().update(voiceTable).set({ active: true }).where(eq(voiceTable.id, id)).run();
}

/** The compact block injected into generation prompts. */
export function voiceBlock(): string {
  const voice = activeVoice();
  if (!voice) {
    return 'VOICE — no profile yet. Write plainly and specifically; avoid marketing register.';
  }
  return renderVoiceForPrompt(voice.markdown, voice.fields);
}

/** My best captions, which is all the voice profile needs to see. */
export function topCaptionsForVoice(limit: number): string[] {
  const self = selfAccount();
  if (!self) return [];
  return db()
    .select({ caption: posts.caption })
    .from(posts)
    .where(and(eq(posts.accountId, self.id), isNotNull(posts.caption)))
    .orderBy(desc(posts.likes))
    .limit(limit)
    .all()
    .map((r) => r.caption ?? '')
    .filter((c) => c.trim().length > 40);
}
