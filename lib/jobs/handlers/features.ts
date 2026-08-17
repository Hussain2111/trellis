import { and, desc, eq, isNotNull, inArray } from 'drizzle-orm';
import path from 'node:path';
import { db } from '../../db/client';
import { postFeatures, posts } from '../../db/schema';
import { env } from '../../env';
import { getTranscriber } from '../../providers';
import { cleanup, download, hasFfmpeg, tempDir, toWav } from '../../media/audio';
import { persistFeatures } from '../../analysis/features';
import { getAccount, listAccounts } from '../../ingest/upsert';
import { getSetting } from '../../settings';
import { JobPermanentError, type JobContext } from '../types';

/** Recompute Layer A features. Cheap enough to always run in full. */
export async function computeFeatures(ctx: JobContext<'compute_features'>): Promise<void> {
  const targets = ctx.payload.accountId
    ? [getAccount(ctx.payload.accountId)].filter((a) => a !== null)
    : listAccounts();

  if (targets.length === 0) throw new JobPermanentError('no accounts to compute features for');

  const multiplier = getSetting('outlierMultiplier');
  let done = 0;

  for (const account of targets) {
    // Spoken hooks already transcribed feed straight back into the hook text.
    const spoken = new Map<number, string>(
      db()
        .select({ postId: postFeatures.postId, spokenHook: postFeatures.spokenHook })
        .from(postFeatures)
        .innerJoin(posts, eq(posts.id, postFeatures.postId))
        .where(and(eq(posts.accountId, account.id), isNotNull(postFeatures.spokenHook)))
        .all()
        .map((r) => [r.postId, r.spokenHook!] as const),
    );

    const count = persistFeatures(account.id, account.followers, multiplier, spoken);
    done++;
    ctx.save({
      progress: done / targets.length,
      label: `@${account.handle}: ${count} posts`,
    });
  }
}

/**
 * Transcribe reel openings, capped and resumable.
 *
 * The cap is the point: transcribing everything means downloading everything,
 * and downloading a thousand videos on a laptop connection is the slowest thing
 * this app could possibly do. The top ~150 reels by engagement carry the signal.
 */
export async function transcribeReels(ctx: JobContext<'transcribe_reels'>): Promise<void> {
  if (!env().ENABLE_TRANSCRIPTION) {
    ctx.save({ progress: 1, label: 'transcription disabled' });
    return;
  }

  const transcriber = getTranscriber();
  if (!(await transcriber.available())) {
    const health = await transcriber.health();
    // Not an error: the app is designed to work caption-only, and the UI says so.
    ctx.save({ progress: 1, label: `skipped — ${health.detail}` });
    return;
  }
  if (!hasFfmpeg()) {
    ctx.save({ progress: 1, label: 'skipped — ffmpeg not on PATH, captions only' });
    return;
  }

  // Already-transcribed posts are skipped forever: transcribe once, ever.
  const transcribed = new Set(
    db()
      .select({ postId: postFeatures.postId })
      .from(postFeatures)
      .where(isNotNull(postFeatures.spokenHook))
      .all()
      .map((r) => r.postId),
  );

  const candidates = db()
    .select()
    .from(posts)
    .where(inArray(posts.type, ['reel', 'video']))
    .orderBy(desc(posts.likes))
    .limit(ctx.payload.cap * 3)
    .all()
    .filter((p) => !transcribed.has(p.id) && (p.mediaUrls?.length ?? 0) > 0)
    .slice(0, ctx.payload.cap);

  if (candidates.length === 0) {
    ctx.save({ progress: 1, label: 'nothing new to transcribe' });
    return;
  }

  const start = typeof ctx.checkpoint === 'number' ? ctx.checkpoint : 0;
  const dir = tempDir();

  try {
    for (let i = start; i < candidates.length; i++) {
      // Checkpoint before each item, so an interrupted run resumes here rather
      // than re-downloading everything it already did.
      if (ctx.shouldStop()) {
        ctx.save({ checkpoint: i, label: `paused at ${i}/${candidates.length}` });
        return;
      }

      const post = candidates[i]!;
      const url = post.mediaUrls?.find((u) => /\.mp4|video/i.test(u)) ?? post.mediaUrls?.[0];
      if (!url) continue;

      const video = path.join(dir, `${post.shortcode}.mp4`);
      const wav = path.join(dir, `${post.shortcode}.wav`);

      try {
        await download(url, video);
        await toWav(video, wav, 15);
        const result = await transcriber.transcribe({ audioPath: wav, seconds: 15 });

        db()
          .insert(postFeatures)
          .values({ postId: post.id, spokenHook: result.text })
          .onConflictDoUpdate({
            target: postFeatures.postId,
            set: { spokenHook: result.text },
          })
          .run();
      } catch (error) {
        // A dead media URL is routine — Instagram CDN links expire. Skip it and
        // keep going rather than failing the whole queue.
        ctx.save({ label: `${post.shortcode}: ${(error as Error).message.slice(0, 60)}` });
      } finally {
        cleanup(video, wav);
      }

      ctx.save({
        progress: (i + 1) / candidates.length,
        label: `${i + 1}/${candidates.length} reels`,
        checkpoint: i + 1,
      });
    }
  } finally {
    cleanup(dir);
  }

  // Hooks changed, so the features that embed them need rebuilding.
  const { enqueue } = await import('../queue');
  enqueue('compute_features', {});
}
