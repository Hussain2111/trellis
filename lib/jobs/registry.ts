import { scanAccount } from './handlers/scan';
import { computeFeatures, transcribeReels } from './handlers/features';
import { clusterPosts, embedPosts } from './handlers/embed';
import { runAnalysis } from './handlers/analysis';
import { buildVoiceProfile, generateDrafts } from './handlers/generate';
import { renderSlides } from './handlers/render';
import { publishDue, refreshIgToken } from './handlers/publish';
import { parsePayload, type JobContext, type JobHandler, type JobType } from './types';

const handlers = new Map<JobType, JobHandler>();

export function register<T extends JobType>(type: T, handler: JobHandler<T>): void {
  handlers.set(type, handler as JobHandler);
}

export function getHandler(type: string): JobHandler | undefined {
  return handlers.get(type as JobType);
}

export function registeredTypes(): JobType[] {
  return [...handlers.keys()];
}

register('scan_account', scanAccount);
register('compute_features', computeFeatures);
register('transcribe_reels', transcribeReels);
register('embed_posts', embedPosts);
register('cluster_posts', clusterPosts);
register('run_analysis', runAnalysis);
register('build_voice_profile', buildVoiceProfile);
register('generate_drafts', generateDrafts);
register('render_slides', renderSlides);
register('publish_due', publishDue);
register('refresh_ig_token', refreshIgToken);

/** Exercised by `worker --selftest` and the queue tests. */
register('noop', async (ctx: JobContext<'noop'>) => {
  const { steps, sleepMs } = ctx.payload;
  const start = typeof ctx.checkpoint === 'number' ? ctx.checkpoint : 0;
  for (let i = start; i < steps; i++) {
    if (ctx.shouldStop()) {
      ctx.save({ checkpoint: i, label: `paused at step ${i}/${steps}` });
      return;
    }
    await new Promise((r) => setTimeout(r, sleepMs));
    ctx.save({ progress: (i + 1) / steps, label: `step ${i + 1}/${steps}`, checkpoint: i + 1 });
  }
});

export { parsePayload };
