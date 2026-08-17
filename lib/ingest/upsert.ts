import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, sqlite } from '../db/client';
import { accounts, posts, type Account } from '../db/schema';
import type { ScrapedPost, ScrapedProfile } from '../providers/scraper/types';

const nowS = (): number => Math.floor(Date.now() / 1000);

export function upsertAccount(input: {
  handle: string;
  role: 'self' | 'competitor';
  notes?: string;
}): Account {
  const handle = input.handle.replace(/^@/, '').trim().toLowerCase();
  if (!handle) throw new Error('handle is empty');

  db()
    .insert(accounts)
    .values({ handle, role: input.role, notes: input.notes ?? null })
    .onConflictDoUpdate({ target: accounts.handle, set: { role: input.role } })
    .run();

  return db().select().from(accounts).where(eq(accounts.handle, handle)).get()!;
}

export function updateAccountProfile(accountId: number, profile: ScrapedProfile): void {
  db()
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
    .where(eq(accounts.id, accountId))
    .run();
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
export function upsertPosts(accountId: number, incoming: ScrapedPost[]): UpsertSummary {
  if (incoming.length === 0) return { inserted: 0, updated: 0, total: 0 };

  const existing = new Set(
    db()
      .select({ shortcode: posts.shortcode })
      .from(posts)
      .where(inArray(posts.shortcode, incoming.map((p) => p.shortcode)))
      .all()
      .map((r) => r.shortcode),
  );

  const t = nowS();
  const run = sqlite().transaction((rows: ScrapedPost[]) => {
    for (const post of rows) {
      db()
        .insert(posts)
        .values({
          accountId,
          shortcode: post.shortcode,
          type: post.type,
          caption: post.caption,
          takenAt: post.takenAt,
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
          firstSeenAt: t,
          lastSeenAt: t,
        })
        .onConflictDoUpdate({
          target: posts.shortcode,
          set: {
            // Metrics move; the post's identity and first sighting do not.
            type: post.type,
            caption: post.caption,
            takenAt: post.takenAt,
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
            lastSeenAt: t,
          },
        })
        .run();
    }
  });
  run(incoming);

  const inserted = incoming.filter((p) => !existing.has(p.shortcode)).length;
  return { inserted, updated: incoming.length - inserted, total: incoming.length };
}

/** Shortcodes we already hold for an account, newest first — the incremental stop set. */
export function knownShortcodes(accountId: number, limit = 400): Set<string> {
  const rows = db()
    .select({ shortcode: posts.shortcode })
    .from(posts)
    .where(eq(posts.accountId, accountId))
    .orderBy(desc(posts.takenAt))
    .limit(limit)
    .all();
  return new Set(rows.map((r) => r.shortcode));
}

export function markScanned(accountId: number): void {
  db().update(accounts).set({ lastScrapedAt: nowS() }).where(eq(accounts.id, accountId)).run();
}

export function listAccounts(role?: 'self' | 'competitor'): Account[] {
  const query = db().select().from(accounts);
  const rows = role ? query.where(eq(accounts.role, role)).all() : query.all();
  return rows.sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0));
}

export function selfAccount(): Account | null {
  return db().select().from(accounts).where(eq(accounts.role, 'self')).get() ?? null;
}

export function getAccount(id: number): Account | null {
  return db().select().from(accounts).where(eq(accounts.id, id)).get() ?? null;
}

export function removeAccount(id: number): void {
  db().delete(accounts).where(and(eq(accounts.id, id), eq(accounts.role, 'competitor'))).run();
}

/** True when the cooldown has elapsed. Scraping costs credits; don't do it twice a day. */
export function isScanDue(account: Account, cooldownDays: number): boolean {
  if (!account.lastScrapedAt) return true;
  return nowS() - account.lastScrapedAt >= cooldownDays * 86400;
}
