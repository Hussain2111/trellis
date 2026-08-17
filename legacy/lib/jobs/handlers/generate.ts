import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { analyses, drafts } from '../../db/schema';
import { benchmarkByFormat, loadCorpus } from '../../analysis/benchmark';
import { saveVoice, topCaptionsForVoice, voiceBlock } from '../../analysis/voice';
import { draftGeneration, type DraftOutput } from '../../prompts/draft-generation.v1';
import { voiceProfile } from '../../prompts/voice-profile.v1';
import { complete } from '../../providers/llm';
import { selfAccount } from '../../ingest/upsert';
import { getSettings } from '../../settings';
import type { Gap, Pattern } from '../../prompts/gap-analysis.v1';
import { JobPermanentError, type JobContext } from '../types';

export async function buildVoiceProfile(ctx: JobContext<'build_voice_profile'>): Promise<void> {
  const self = selfAccount();
  if (!self) throw new JobPermanentError('No account marked as yours.');

  const captions = topCaptionsForVoice(ctx.payload.topN);
  if (captions.length < 5) {
    throw new JobPermanentError(
      `Only ${captions.length} usable captions. Scan your account first — a voice profile from three posts is a guess.`,
    );
  }

  ctx.save({ progress: 0.3, label: `reading your ${captions.length} best captions` });
  const settings = getSettings();

  const result = await complete({
    // The privacy switch routes this away from the cloud entirely. Slower and
    // worse, which is the trade the user explicitly opted into.
    tier: settings.localOnlyVoiceAndChat ? 'B' : 'A',
    operation: 'voice_profile',
    system: voiceProfile.system,
    prompt: voiceProfile.render({
      handle: self.handle,
      niche: settings.niche,
      captions,
    }),
    schema: voiceProfile.schema!,
    maxOutputTokens: 2048,
    temperature: 0.2,
  });

  saveVoice({
    markdown: result.value.markdown,
    fields: result.value.fields,
    generatedBy: `${result.generatedBy}${result.degraded ? ' (degraded)' : ''}`,
    editedByUser: false,
  });

  ctx.save({ progress: 1, label: 'voice profile saved' });
}

/**
 * Pick the batch's format mix from what is actually winning in the niche,
 * not an even split. Deterministic — no reason to spend a model call on it.
 */
export function formatMix(count: number): ('carousel' | 'reel' | 'image')[] {
  const benchmark = benchmarkByFormat(loadCorpus());
  const eligible = benchmark
    .map((b) => ({
      format: (b.type === 'video' ? 'reel' : b.type) as 'carousel' | 'reel' | 'image',
      weight: b.niche.share * (b.niche.medianEngagementRate || 0.001),
    }))
    .filter((b) => ['carousel', 'reel', 'image'].includes(b.format));

  if (eligible.length === 0) {
    const fallback: ('carousel' | 'reel' | 'image')[] = ['reel', 'carousel', 'image'];
    return Array.from({ length: count }, (_, i) => fallback[i % 3]!);
  }

  const total = eligible.reduce((sum, e) => sum + e.weight, 0) || 1;
  const out: ('carousel' | 'reel' | 'image')[] = [];
  for (const entry of eligible) {
    const share = Math.round((entry.weight / total) * count);
    for (let i = 0; i < share; i++) out.push(entry.format);
  }
  while (out.length < count) out.push(eligible[0]!.format);
  return out.slice(0, count);
}

export async function generateDrafts(ctx: JobContext<'generate_drafts'>): Promise<void> {
  const analysis = db().select().from(analyses).where(eq(analyses.id, ctx.payload.analysisId)).get();
  if (!analysis) throw new JobPermanentError(`analysis ${ctx.payload.analysisId} not found`);

  const settings = getSettings();
  const patterns = analysis.patterns as Pattern[];
  const gap = analysis.gap as Gap;
  const voice = voiceBlock();
  const mix = formatMix(ctx.payload.count);

  // 3-4 per call. A 12-draft response is long, and a long response that fails
  // schema validation costs a full retry of the whole batch.
  const batchSize = 3;
  const start = typeof ctx.checkpoint === 'number' ? ctx.checkpoint : 0;
  const existingTitles = db()
    .select({ title: drafts.title })
    .from(drafts)
    .where(eq(drafts.analysisId, analysis.id))
    .all()
    .map((r) => r.title);

  for (let i = start; i < mix.length; i += batchSize) {
    if (ctx.shouldStop()) {
      ctx.save({ checkpoint: i, label: `paused at ${i}/${mix.length}` });
      return;
    }

    const formats = mix.slice(i, i + batchSize);
    const result = await complete({
      tier: 'A',
      operation: 'draft_generation',
      system: draftGeneration.system,
      prompt: draftGeneration.render({
        voice,
        niche: settings.niche,
        gap: `${gap.claim} (${gap.niche_stat} vs ${gap.my_stat} — ${gap.delta}). ${gap.why_this_one}`,
        patterns: patterns.map((p, index) => ({
          index,
          claim: p.claim,
          niche_stat: p.niche_stat,
          my_stat: p.my_stat,
        })),
        formats,
        avoidTitles: existingTitles,
      }),
      schema: draftGeneration.schema!,
      maxOutputTokens: 4096,
      temperature: 0.7,
    });

    for (const draft of result.value.drafts) {
      const id = insertDraft(draft, analysis.id, `${result.generatedBy}${result.degraded ? ' (degraded)' : ''}`);
      existingTitles.push(draft.title);
      void id;
    }

    ctx.save({
      progress: Math.min(1, (i + formats.length) / mix.length),
      label: `${Math.min(i + formats.length, mix.length)}/${mix.length} drafts`,
      checkpoint: i + batchSize,
    });
  }
}

export function insertDraft(draft: DraftOutput, analysisId: number, generatedBy: string): number {
  const row = db()
    .insert(drafts)
    .values({
      analysisId,
      format: draft.format,
      patternIndex: draft.pattern_index,
      title: draft.title,
      hook: draft.hook,
      body: draft.body,
      caption: draft.caption,
      hashtags: draft.hashtags,
      cta: draft.cta,
      rationale: draft.rationale,
      evidence: draft.evidence,
      status: 'draft',
      generatedBy,
    })
    .returning({ id: drafts.id })
    .get();
  return row.id;
}

export function listDrafts(status?: string) {
  const query = db().select().from(drafts).orderBy(desc(drafts.id));
  return status ? query.where(eq(drafts.status, status as 'draft')).all() : query.all();
}

export function draftById(id: number) {
  return db().select().from(drafts).where(eq(drafts.id, id)).get() ?? null;
}
