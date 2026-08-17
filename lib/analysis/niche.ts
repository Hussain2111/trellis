import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { accounts, posts, type Account } from '../db/schema';
import { complete } from '../providers/llm';
import {
  buildNicheInferencePrompt,
  nicheInferenceSchema,
  NICHE_INFERENCE_SYSTEM,
  type NicheInference,
} from '../prompts/niche-inference.v1';
import { topHashtags } from './hashtags';

/**
 * Infers the account's niche from its bio, recent captions, and most-used
 * hashtags — a single model call, per the spec. The result is written onto
 * the account row and also handed back so the caller (discover-competitors)
 * doesn't need to re-fetch it.
 */
export async function inferAndStoreNiche(account: Account): Promise<NicheInference> {
  const ownPosts = await db()
    .select({ caption: posts.caption })
    .from(posts)
    .where(eq(posts.accountId, account.id))
    .limit(50);

  const captions = ownPosts.map((p) => p.caption).filter((c): c is string => !!c);
  const hashtags = topHashtags(ownPosts, 8);

  const result = await complete<NicheInference>({
    operation: 'niche_inference',
    system: NICHE_INFERENCE_SYSTEM,
    prompt: buildNicheInferencePrompt({
      handle: account.handle,
      bio: account.bio,
      captions,
      hashtags,
    }),
    schema: nicheInferenceSchema,
    temperature: 0.3,
  });

  await db().update(accounts).set({ niche: result.value.niche }).where(eq(accounts.id, account.id));

  return result.value;
}
