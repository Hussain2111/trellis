import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { hookLabels, postFeatures, posts, type Post } from '../db/schema';
import { complete } from '../providers/llm';
import {
  buildHookClassificationPrompt,
  hookClassificationSchema,
  HOOK_CLASSIFICATION_SYSTEM,
} from '../prompts/hook-classification.v1';

export interface UnclassifiedPost {
  id: number;
  type: Post['type'];
  hookText: string;
}

/** Posts that have features computed but no hook label yet — the classification backlog. */
export async function findUnclassifiedPosts(
  accountId: number | undefined,
  limit: number,
): Promise<UnclassifiedPost[]> {
  const rows = await db()
    .select({ id: posts.id, type: posts.type, hookText: postFeatures.hookText })
    .from(posts)
    .innerJoin(postFeatures, eq(postFeatures.postId, posts.id))
    .leftJoin(hookLabels, eq(hookLabels.postId, posts.id))
    .where(
      and(
        isNull(hookLabels.postId),
        ...(accountId !== undefined ? [eq(posts.accountId, accountId)] : []),
      ),
    )
    .limit(limit);

  return rows.map((r) => ({ id: r.id, type: r.type, hookText: r.hookText ?? '' }));
}

export async function countUnclassified(accountId: number | undefined): Promise<number> {
  const rows = await db()
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(postFeatures, eq(postFeatures.postId, posts.id))
    .leftJoin(hookLabels, eq(hookLabels.postId, posts.id))
    .where(
      and(
        isNull(hookLabels.postId),
        ...(accountId !== undefined ? [eq(posts.accountId, accountId)] : []),
      ),
    );
  return rows.length;
}

/** One Gemini call per post — matches the spec's "per-post LLM classification". */
export async function classifyHook(
  post: UnclassifiedPost,
): Promise<{ category: string; confidence: number; generatedBy: string }> {
  const result = await complete({
    operation: 'hook_classification',
    system: HOOK_CLASSIFICATION_SYSTEM,
    prompt: buildHookClassificationPrompt({ hookText: post.hookText, postType: post.type }),
    schema: hookClassificationSchema,
    temperature: 0.1,
  });
  return {
    category: result.value.category,
    confidence: result.value.confidence,
    generatedBy: result.generatedBy,
  };
}

export async function saveHookLabel(
  postId: number,
  category: string,
  confidence: number,
  generatedBy: string,
): Promise<void> {
  await db()
    .insert(hookLabels)
    .values({ postId, category, confidence, generatedBy })
    .onConflictDoUpdate({ target: hookLabels.postId, set: { category, confidence, generatedBy } });
}
