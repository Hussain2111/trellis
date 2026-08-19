import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { followerDaily, followerSnapshots, type FollowerSnapshot } from '../db/schema';

/**
 * Unfollows has two layers, and they answer different questions.
 *
 * The free layer is `follower_daily`: how many, every day, from the Graph
 * API. It cannot name anyone — Meta does not expose a follower list at all.
 *
 * The paid layer is `follower_snapshots`: who, from a scrape, on demand. The
 * diff between two snapshots is computed here rather than stored, so it stays
 * correct as new snapshots arrive.
 */

export interface FollowerDelta {
  day: string;
  followerCount: number | null;
  change: number | null;
  follows: number | null;
  unfollows: number | null;
  unavailableReason: string | null;
}

/**
 * Daily follower counts with the day-over-day change derived, newest first.
 * `change` is null for the oldest row in the window and wherever a day is
 * missing — a gap is not a flat day, and rendering it as 0 would invent a
 * fact.
 */
export async function followerHistory(days = 30): Promise<FollowerDelta[]> {
  const rows = await db()
    .select()
    .from(followerDaily)
    .orderBy(desc(followerDaily.day))
    .limit(days + 1);

  return rows.slice(0, days).map((row, i) => {
    const previous = rows[i + 1];
    const consecutive = previous ? isPreviousDay(previous.day, row.day) : false;
    const change =
      consecutive && previous?.followerCount != null && row.followerCount != null
        ? row.followerCount - previous.followerCount
        : null;
    return {
      day: row.day,
      followerCount: row.followerCount,
      change,
      follows: row.follows,
      unfollows: row.unfollows,
      unavailableReason: row.unavailableReason,
    };
  });
}

function isPreviousDay(earlier: string, later: string): boolean {
  const a = Date.parse(`${earlier}T00:00:00Z`);
  const b = Date.parse(`${later}T00:00:00Z`);
  return b - a === 86_400_000;
}

export interface SnapshotDiff {
  from: FollowerSnapshot;
  to: FollowerSnapshot;
  lost: string[];
  gained: string[];
  /** True when either snapshot was truncated — the names below are then unreliable. */
  unreliable: boolean;
  note: string | null;
}

/**
 * Names who left between the two most recent snapshots. Refuses to guess: a
 * truncated snapshot makes every "lost" name indistinguishable from a name
 * the scrape simply never reached, so the diff is returned flagged rather
 * than silently wrong.
 */
export async function latestSnapshotDiff(accountId: number): Promise<SnapshotDiff | null> {
  const snapshots = await db()
    .select()
    .from(followerSnapshots)
    .where(eq(followerSnapshots.accountId, accountId))
    .orderBy(desc(followerSnapshots.capturedAt))
    .limit(2);

  const [to, from] = snapshots;
  if (!to || !from) return null;

  const before = new Set(from.usernames);
  const after = new Set(to.usernames);
  const unreliable = !from.complete || !to.complete;

  return {
    from,
    to,
    lost: from.usernames.filter((u) => !after.has(u)),
    gained: to.usernames.filter((u) => !before.has(u)),
    unreliable,
    note: unreliable
      ? 'One of these snapshots was truncated, so a name shown as lost may just be a name the scrape never reached.'
      : null,
  };
}

export async function listSnapshots(accountId: number, limit = 10): Promise<FollowerSnapshot[]> {
  return db()
    .select()
    .from(followerSnapshots)
    .where(eq(followerSnapshots.accountId, accountId))
    .orderBy(desc(followerSnapshots.capturedAt))
    .limit(limit);
}

export async function recordSnapshot(input: {
  accountId: number;
  usernames: string[];
  complete: boolean;
  note?: string | null;
}): Promise<number> {
  const [row] = await db()
    .insert(followerSnapshots)
    .values({
      accountId: input.accountId,
      usernames: input.usernames,
      count: input.usernames.length,
      complete: input.complete,
      note: input.note ?? null,
    })
    .returning({ id: followerSnapshots.id });
  return row!.id;
}
