import {
  classifyHook,
  countUnclassified,
  findUnclassifiedPosts,
  saveHookLabel,
} from '../../analysis/hooks';
import { QuotaExhausted } from '../../providers/llm';
import { enqueue } from '../queue';
import { JobYield, type JobContext } from '../types';

/** Posts classified per invocation before yielding — keeps each tick well inside a Vercel function's budget. */
const BATCH_SIZE = 5;

/**
 * One Gemini call per post, per the spec. Never blocks for the whole
 * backlog: classifies a small batch, then yields (JobYield) so a resumed
 * tick — or tomorrow's, if the daily quota for this job type is spent —
 * picks up exactly where this one left off. There's no checkpoint to carry
 * between ticks because "the next unclassified post" is itself the state,
 * held in `hook_labels`.
 */
export async function classifyHooks(ctx: JobContext<'classify_hooks'>): Promise<void> {
  const accountId = ctx.payload.accountId;
  const batch = await findUnclassifiedPosts(accountId, BATCH_SIZE);

  if (batch.length === 0) {
    await ctx.save({ progress: 1, label: 'all posts classified' });
    await enqueue('run_analysis', { windowDays: 30 }, { dedupe: true });
    return;
  }

  let classified = 0;
  for (const post of batch) {
    try {
      const result = await classifyHook(post);
      await saveHookLabel(post.id, result.category, result.confidence, result.generatedBy);
      classified++;
    } catch (error) {
      if (error instanceof QuotaExhausted) {
        await ctx.save({
          progress: 0,
          label: `daily hook-classification quota spent; ${classified} done this tick`,
        });
        throw new JobYield('quota exhausted', 3600);
      }
      // A single post's classification failing (malformed model output twice,
      // a transient network error) shouldn't stall the whole backlog — it's
      // picked up again next time findUnclassifiedPosts() runs.
    }
  }

  const remaining = await countUnclassified(accountId);
  if (remaining > 0) {
    await ctx.save({ progress: 0, label: `${classified} classified this tick, ${remaining} left` });
    throw new JobYield('more posts to classify', 2);
  }

  await ctx.save({ progress: 1, label: `${classified} classified, backlog clear` });
  await enqueue('run_analysis', { windowDays: 30 }, { dedupe: true });
}
