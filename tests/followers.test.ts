import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, followerSnapshots } from '../lib/db/schema';
import { latestSnapshotDiff, recordSnapshot } from '../lib/insights/followers';
import {
  applyFollowerSnapshot,
  normalizeFollowerItems,
} from '../lib/jobs/handlers/snapshot-followers';
import { upsertAccount } from '../lib/ingest/upsert';

afterEach(async () => {
  await db().delete(followerSnapshots);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

describe('normalizeFollowerItems', () => {
  it('accepts the field names the actor might use, lowercases, and de-duplicates', () => {
    const items = [
      { username: 'Alpha' },
      { ownerUsername: 'beta' },
      { handle: '@Gamma' },
      { username: 'alpha' },
      { nothing: true },
      null,
    ];
    expect(normalizeFollowerItems(items).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('applyFollowerSnapshot', () => {
  it('flags a snapshot that hit the limit as incomplete', async () => {
    const account = await upsertAccount({ handle: 'snap1', role: 'self' });
    const items = Array.from({ length: 5 }, (_, i) => ({ username: `u${i}` }));

    const result = await applyFollowerSnapshot(account.id, items, 5);
    expect(result.complete).toBe(false);

    const [row] = await db().select().from(followerSnapshots);
    expect(row!.complete).toBe(false);
    expect(row!.note).toMatch(/Truncated/);
  });

  it('treats a short list as complete', async () => {
    const account = await upsertAccount({ handle: 'snap2', role: 'self' });
    const result = await applyFollowerSnapshot(account.id, [{ username: 'a' }], 100);
    expect(result.complete).toBe(true);
    expect(result.count).toBe(1);
  });
});

describe('latestSnapshotDiff', () => {
  it('names who left and who arrived between the two most recent snapshots', async () => {
    const account = await upsertAccount({ handle: 'snap3', role: 'self' });
    await recordSnapshot({ accountId: account.id, usernames: ['a', 'b', 'c'], complete: true });
    await new Promise((r) => setTimeout(r, 10));
    await recordSnapshot({ accountId: account.id, usernames: ['b', 'c', 'd'], complete: true });

    const diff = await latestSnapshotDiff(account.id);
    expect(diff!.lost).toEqual(['a']);
    expect(diff!.gained).toEqual(['d']);
    expect(diff!.unreliable).toBe(false);
    expect(diff!.note).toBeNull();
  });

  it('flags the diff as unreliable when either snapshot was truncated', async () => {
    const account = await upsertAccount({ handle: 'snap4', role: 'self' });
    await recordSnapshot({ accountId: account.id, usernames: ['a', 'b'], complete: false });
    await new Promise((r) => setTimeout(r, 10));
    await recordSnapshot({ accountId: account.id, usernames: ['b'], complete: true });

    const diff = await latestSnapshotDiff(account.id);
    // 'a' looks lost, but may just be a name the truncated scrape never reached.
    expect(diff!.lost).toEqual(['a']);
    expect(diff!.unreliable).toBe(true);
    expect(diff!.note).toMatch(/truncated/i);
  });

  it('returns null with only one snapshot — one reading is a baseline, not a diff', async () => {
    const account = await upsertAccount({ handle: 'snap5', role: 'self' });
    await recordSnapshot({ accountId: account.id, usernames: ['a'], complete: true });
    expect(await latestSnapshotDiff(account.id)).toBeNull();
  });
});
