import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { accounts, posts, type Account } from '../db/schema';
import type { ScrapedPost, ScrapedProfile } from '../providers/scraper/types';

const toDate = (epochS: number | null): Date | null =>
  epochS === null ? null : new Date(epochS * 1000);

export async function upsertAccount(input: {
  handle: string;
  role: 'self' | 'competitor';
  discoveredViaHashtag?: string;
}): Promise<Account> {
  const handle = input.handle.replace(/^@/, '').trim().toLowerCase();
  if (!handle) throw new Error('handle is empty');

  await db()
    .insert(accounts)
    .values({
      handle,
      role: input.role,
      discoveredViaHashtag: input.discoveredViaHashtag ?? null,
    })
    .onConflictDoUpdate({ target: accounts.handle, set: { role: input.role } });

  const [row] = await db().select().from(accounts).where(eq(accounts.handle, handle)).limit(1);
  return row!;
}

export async function updateAccountProfile(
  accountId: number,
  profile: ScrapedProfile,
): Promise<void> {
  await db()
    .update(accounts)
    .set({
      igUserId: profile.igUserId,
      fullName: profile.fullName,
      bio: profile.bio,
      followers: profile.followers,
      following: profile.following,
      postsCount: profile.postsCount,
      isVerified: profile.isVerified,
    })
    .where(eq(accounts.id, accountId));
}

export interface UpsertSummary {
  inserted: number;
  updated: number;
  total: number;
}

/**
 * Idempotent on `shortcode`. Re-scanning the same window never duplicates a
 * post and never loses history: metrics are refreshed, `first_seen_at` is not.
 *
 * One transaction for the whole batch — a scan that dies halfway leaves the
 * database on a post boundary rather than mid-write.
 */
export async function upsertPosts(
  accountId: number,
  incoming: ScrapedPost[],
): Promise<UpsertSummary> {
  if (incoming.length === 0) return { inserted: 0, updated: 0, total: 0 };

  const existingRows = await db()
    .select({ shortcode: posts.shortcode })
    .from(posts)
    .where(
      inArray(
        posts.shortcode,
        incoming.map((p) => p.shortcode),
      ),
    );
  const existing = new Set(existingRows.map((r) => r.shortcode));

  const now = new Date();
  await db().transaction(async (tx) => {
    for (const post of incoming) {
      await tx
        .insert(posts)
        .values({
          accountId,
          shortcode: post.shortcode,
          type: post.type,
          caption: post.caption,
          takenAt: toDate(post.takenAt),
          likes: post.likes,
          comments: post.comments,
          views: post.views,
          plays: post.plays,
          durationS: post.durationS,
          carouselCount: post.carouselCount,
          thumbnailUrl: post.thumbnailUrl,
          mediaUrls: post.mediaUrls,
          isSponsored: post.isSponsored,
          raw: post.raw ?? {},
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: posts.shortcode,
          set: {
            // Metrics move; the post's identity and first sighting do not.
            type: post.type,
            caption: post.caption,
            takenAt: toDate(post.takenAt),
            likes: post.likes,
            comments: post.comments,
            views: post.views,
            plays: post.plays,
            durationS: post.durationS,
            carouselCount: post.carouselCount,
            thumbnailUrl: post.thumbnailUrl,
            mediaUrls: post.mediaUrls,
            isSponsored: post.isSponsored,
            raw: post.raw ?? {},
            lastSeenAt: now,
          },
        });
    }
  });

  const inserted = incoming.filter((p) => !existing.has(p.shortcode)).length;
  return { inserted, updated: incoming.length - inserted, total: incoming.length };
}

/** Shortcodes we already hold for an account, newest first — the incremental stop set. */
export async function knownShortcodes(accountId: number, limit = 400): Promise<Set<string>> {
  const rows = await db()
    .select({ shortcode: posts.shortcode })
    .from(posts)
    .where(eq(posts.accountId, accountId))
    .orderBy(desc(posts.takenAt))
    .limit(limit);
  return new Set(rows.map((r) => r.shortcode));
}

export async function markScanned(accountId: number): Promise<void> {
  await db().update(accounts).set({ lastScrapedAt: new Date() }).where(eq(accounts.id, accountId));
}

export async function listAccounts(role?: 'self' | 'competitor'): Promise<Account[]> {
  const rows = role
    ? await db().select().from(accounts).where(eq(accounts.role, role))
    : await db().select().from(accounts);
  return rows.sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0));
}

export async function selfAccount(): Promise<Account | null> {
  const [row] = await db().select().from(accounts).where(eq(accounts.role, 'self')).limit(1);
  return row ?? null;
}

export async function getAccount(id: number): Promise<Account | null> {
  const [row] = await db().select().from(accounts).where(eq(accounts.id, id)).limit(1);
  return row ?? null;
}

export async function removeAccount(id: number): Promise<void> {
  await db()
    .delete(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.role, 'competitor')));
}

/** True when the cooldown has elapsed. Scraping costs credits; don't do it twice a day. */
export function isScanDue(account: Account, cooldownDays: number): boolean {
  if (!account.lastScrapedAt) return true;
  return Date.now() - account.lastScrapedAt.getTime() >= cooldownDays * 86400 * 1000;
}
