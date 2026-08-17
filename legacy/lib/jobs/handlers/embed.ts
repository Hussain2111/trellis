import { env } from '../../env';
import { embed } from '../../providers/llm';
import { clusterNaming } from '../../prompts/cluster-naming.v1';
import { complete } from '../../providers/llm';
import { getSetting, getSettings } from '../../settings';
import {
  clusterCorpus,
  labelNewPosts,
  loadEmbeddings,
  persistClustering,
  postsNeedingEmbedding,
  saveEmbedding,
} from '../../analysis/archetypes';
import { JobPermanentError, type JobContext } from '../types';

/**
 * Embed every post's hook locally. This is the workhorse of the analysis layer
 * and the main reason Tier B exists — it is free, unlimited, and the only part
 * of the pipeline that touches all 1,100 posts.
 */
export async function embedPosts(ctx: JobContext<'embed_posts'>): Promise<void> {
  const model = ctx.payload.model ?? getSetting('ollamaEmbedModel') ?? env().OLLAMA_EMBED_MODEL;
  const pending = postsNeedingEmbedding(model);

  if (pending.length === 0) {
    ctx.save({ progress: 1, label: 'all posts already embedded' });
    return;
  }

  // Batched, with a checkpoint per batch. Embedding 1,100 posts takes minutes
  // on this hardware and will get interrupted.
  const batchSize = 32;
  const start = typeof ctx.checkpoint === 'number' ? ctx.checkpoint : 0;

  for (let i = start; i < pending.length; i += batchSize) {
    if (ctx.shouldStop()) {
      ctx.save({ checkpoint: i, label: `paused at ${i}/${pending.length}` });
      return;
    }

    const batch = pending.slice(i, i + batchSize);
    const { vectors, model: usedModel } = await embed(batch.map((b) => b.text));

    batch.forEach((item, index) => {
      const vector = vectors[index];
      if (vector) saveEmbedding(item.postId, vector, usedModel, item.text);
    });

    ctx.save({
      progress: Math.min(1, (i + batch.length) / pending.length),
      label: `embedded ${Math.min(i + batch.length, pending.length)}/${pending.length}`,
      checkpoint: i + batchSize,
    });
  }

  // New posts join existing archetypes by proximity — no model call.
  const assigned = labelNewPosts(loadEmbeddings(model));
  if (assigned > 0) ctx.save({ label: `assigned ${assigned} new post(s) to existing archetypes` });
}

/**
 * Cluster, then name every cluster in a single Tier A call.
 *
 * One call for the whole label set is the entire point: naming per post would
 * be ~55 batched calls at minutes of prefill each, and would produce a label
 * set too unstable to benchmark against.
 */
export async function clusterPosts(ctx: JobContext<'cluster_posts'>): Promise<void> {
  const settings = getSettings();
  const embeddings = loadEmbeddings();

  if (embeddings.length < 10) {
    throw new JobPermanentError(
      `Only ${embeddings.length} embedded posts. Run the embedding job first.`,
    );
  }

  ctx.save({ progress: 0.1, label: `clustering ${embeddings.length} posts` });

  const outcome = clusterCorpus(embeddings, ctx.payload.kMin, ctx.payload.kMax, (k, score) => {
    ctx.save({ label: `k=${k} silhouette=${score.toFixed(3)}` });
  });

  ctx.save({
    progress: 0.7,
    label: `k=${outcome.k}, silhouette ${outcome.silhouette.toFixed(3)} — naming clusters`,
  });

  let names: { clusterId: number; name: string; description: string }[] = [];
  let generatedBy = 'deterministic:unnamed';

  try {
    const result = await complete({
      tier: 'A',
      operation: 'cluster_naming',
      system: clusterNaming.system,
      prompt: clusterNaming.render({
        niche: settings.niche,
        clusters: outcome.representatives.map((r) => ({
          clusterId: r.clusterId,
          size: r.size,
          examples: r.examples,
        })),
      }),
      schema: clusterNaming.schema!,
      maxOutputTokens: 2048,
    });

    names = result.value.clusters.map((c) => ({
      clusterId: c.cluster_id,
      name: c.name,
      description: c.description,
    }));
    generatedBy = `${result.generatedBy}${result.degraded ? ' (degraded)' : ''}`;
  } catch (error) {
    // Unnamed clusters are still useful — the arithmetic works either way, and
    // names can be filled in later or by hand.
    ctx.save({ label: `naming failed (${(error as Error).message.slice(0, 80)}) — keeping numbers` });
  }

  const { created, inherited } = persistClustering(outcome, names, generatedBy);

  ctx.save({
    progress: 1,
    label: `${created} archetypes${inherited ? `, ${inherited} name(s) kept from your renames` : ''}`,
    checkpoint: { k: outcome.k, silhouette: outcome.silhouette, created, inherited },
  });
}
