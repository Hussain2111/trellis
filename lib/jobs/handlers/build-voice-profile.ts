import { desc } from 'drizzle-orm';
import { db } from '../../db/client';
import { analyses } from '../../db/schema';
import { saveVoice, topCaptionsForVoice } from '../../analysis/voice';
import { complete } from '../../providers/llm';
import {
  buildVoiceProfilePrompt,
  voiceProfileSchema,
  VOICE_PROFILE_SYSTEM,
} from '../../prompts/voice-profile.v1';
import { selfAccount } from '../../ingest/upsert';
import { enqueue } from '../queue';
import { JobPermanentError, JobYield, type JobContext } from '../types';

export async function buildVoiceProfile(ctx: JobContext<'build_voice_profile'>): Promise<void> {
  const self = await selfAccount();
  if (!self) throw new JobPermanentError('no self account configured yet');

  const captions = await topCaptionsForVoice(ctx.payload.topN);
  if (captions.length === 0) {
    throw new JobYield('no captions available yet', 30);
  }

  const result = await complete({
    operation: 'voice_profile',
    system: VOICE_PROFILE_SYSTEM,
    prompt: buildVoiceProfilePrompt({ handle: self.handle, niche: self.niche, captions }),
    schema: voiceProfileSchema,
    temperature: 0.4,
  });

  await saveVoice({
    markdown: result.value.markdown,
    fields: result.value.fields,
    generatedBy: result.generatedBy,
  });

  await ctx.save({ progress: 1, label: 'voice profile saved' });

  const [latestAnalysis] = await db()
    .select({ id: analyses.id })
    .from(analyses)
    .orderBy(desc(analyses.id))
    .limit(1);
  if (latestAnalysis) {
    await enqueue(
      'generate_drafts',
      { analysisId: latestAnalysis.id, count: 12 },
      { dedupe: true },
    );
  }
}
