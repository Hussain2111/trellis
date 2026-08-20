import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import '../lib/bootstrap-env';
import { closeDb, db } from '../lib/db/client';

/**
 * Reconciles the v1 → v2 calendar migration against real rows.
 *
 * The `drafts` + `schedule` → `calendar_entries` backfill is the one
 * irreversible step in this project, and migration 0002 drops the source
 * tables — so "before" has to be captured while they still exist. Hence two
 * passes with a file in between rather than one clever query.
 *
 *   npm run verify:migration -- --before out.json   # run BEFORE db:migrate
 *   npm run db:migrate
 *   npm run verify:migration -- --after out.json    # run AFTER
 *
 * Read-only in both directions: it never writes to the database.
 */

interface DraftRow extends Record<string, unknown> {
  id: number;
  format: string;
  title: string | null;
  hook: string | null;
  caption: string | null;
  hashtags: unknown;
  rationale: string | null;
  status: string;
  slideUrls: string[];
}

interface ScheduleRow extends Record<string, unknown> {
  id: number;
  draftId: number;
  scheduledFor: string;
  status: string;
  attempts: number;
  igMediaId: string | null;
  publishedAt: string | null;
}

interface Snapshot {
  capturedAt: string;
  counts: { drafts: number; schedule: number; draftAssets: number; voiceProfile: number };
  drafts: DraftRow[];
  schedule: ScheduleRow[];
  /** Drafts with no schedule row — these are intentionally NOT migrated. */
  unscheduledDraftIds: number[];
  /** Schedule rows pointing at a draft that no longer exists. Should be zero (FK). */
  orphanScheduleIds: number[];
}

async function capture(outPath: string): Promise<void> {
  const counts = {
    drafts: await count('drafts'),
    schedule: await count('schedule'),
    draftAssets: await count('draft_assets'),
    voiceProfile: await count('voice_profile'),
  };

  const drafts = await db().execute<DraftRow>(sql`
    SELECT d.id,
           d.format,
           d.title,
           d.hook,
           d.caption,
           d.hashtags,
           d.rationale,
           d.status,
           COALESCE((
             SELECT json_agg(a.public_url ORDER BY a.slide_index NULLS LAST, a.id)
               FROM draft_assets a
              WHERE a.draft_id = d.id
                AND a.kind = 'slide'
                AND a.public_url IS NOT NULL
           ), '[]'::json) AS "slideUrls"
      FROM drafts d
     ORDER BY d.id
  `);

  const schedule = await db().execute<ScheduleRow>(sql`
    SELECT s.id,
           s.draft_id      AS "draftId",
           s.scheduled_for AS "scheduledFor",
           s.status,
           s.attempts,
           s.ig_media_id   AS "igMediaId",
           s.published_at  AS "publishedAt"
      FROM schedule s
     ORDER BY s.id
  `);

  const scheduledDraftIds = new Set(schedule.map((s) => s.draftId));
  const draftIds = new Set(drafts.map((d) => d.id));

  const snapshot: Snapshot = {
    capturedAt: new Date().toISOString(),
    counts,
    drafts,
    schedule,
    unscheduledDraftIds: drafts.filter((d) => !scheduledDraftIds.has(d.id)).map((d) => d.id),
    orphanScheduleIds: schedule.filter((s) => !draftIds.has(s.draftId)).map((s) => s.id),
  };

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  console.log('--- BEFORE ---------------------------------------------------');
  console.log(`drafts          ${counts.drafts}`);
  console.log(`schedule        ${counts.schedule}`);
  console.log(`draft_assets    ${counts.draftAssets}`);
  console.log(`voice_profile   ${counts.voiceProfile}`);
  console.log('');
  console.log(`Expected calendar_entries after migration: ${counts.schedule}`);
  console.log(
    `Drafts that will NOT carry over (never scheduled): ${snapshot.unscheduledDraftIds.length}` +
      (snapshot.unscheduledDraftIds.length > 0
        ? ` — ids ${snapshot.unscheduledDraftIds.join(', ')}`
        : ''),
  );
  if (snapshot.orphanScheduleIds.length > 0) {
    console.log(
      `WARNING: ${snapshot.orphanScheduleIds.length} schedule row(s) reference a missing draft ` +
        `and will be dropped by the JOIN: ids ${snapshot.orphanScheduleIds.join(', ')}`,
    );
  }
  console.log('');
  console.log(`Snapshot written to ${outPath}. Run db:migrate, then --after.`);
}

interface EntryRow extends Record<string, unknown> {
  id: number;
  scheduledFor: string;
  status: string;
  format: string;
  title: string;
  hook: string | null;
  caption: string;
  hashtags: unknown;
  notes: string | null;
  mediaUrls: string[];
  attempts: number;
  igMediaId: string | null;
  publishedAt: string | null;
}

const STATUS_MAP: Record<string, string> = {
  pending: 'planned',
  claimed: 'claimed',
  publishing: 'publishing',
  published: 'published',
  failed: 'failed',
};

async function reconcile(snapshotPath: string): Promise<void> {
  const before = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as Snapshot;

  const entries = await db().execute<EntryRow>(sql`
    SELECT id,
           scheduled_for AS "scheduledFor",
           status,
           format,
           title,
           hook,
           caption,
           hashtags,
           notes,
           media_urls    AS "mediaUrls",
           attempts,
           ig_media_id   AS "igMediaId",
           published_at  AS "publishedAt"
      FROM calendar_entries
     ORDER BY id
  `);

  const draftsById = new Map(before.drafts.map((d) => [d.id, d]));
  const expected = before.schedule.filter((s) => draftsById.has(s.draftId));

  const problems: string[] = [];
  const losses: string[] = [];

  console.log('--- AFTER ----------------------------------------------------');
  console.log(`schedule rows before      ${before.counts.schedule}`);
  console.log(`  of which joinable       ${expected.length}`);
  console.log(`calendar_entries after    ${entries.length}`);
  console.log('');

  if (entries.length !== expected.length) {
    problems.push(
      `COUNT MISMATCH: expected ${expected.length} calendar_entries, found ${entries.length}.`,
    );
  }

  // Migration 0001 backfills ORDER BY schedule.id, so the nth entry corresponds
  // to the nth joinable schedule row. Any entry added since is extra.
  for (let i = 0; i < Math.min(expected.length, entries.length); i++) {
    const s = expected[i]!;
    const d = draftsById.get(s.draftId)!;
    const e = entries[i]!;
    const where = `schedule #${s.id} (draft #${d.id}) → entry #${e.id}`;

    const expectedStatus = STATUS_MAP[s.status] ?? s.status;
    if (e.status !== expectedStatus) {
      problems.push(
        `${where}: status '${s.status}' became '${e.status}', expected '${expectedStatus}'.`,
      );
    }

    // Field-level loss: the source had a value, the destination does not.
    if (nonEmpty(d.caption) && !nonEmpty(e.caption)) losses.push(`${where}: caption lost.`);
    if (nonEmpty(d.hook) && !nonEmpty(e.hook)) losses.push(`${where}: hook lost.`);
    if (nonEmpty(d.title) && !nonEmpty(e.title)) losses.push(`${where}: title lost.`);
    if (nonEmpty(d.rationale) && !nonEmpty(e.notes)) losses.push(`${where}: rationale/notes lost.`);
    if (!nonEmpty(e.format)) losses.push(`${where}: format empty.`);

    const srcTags = asArray(d.hashtags);
    const dstTags = asArray(e.hashtags);
    if (srcTags.length !== dstTags.length) {
      losses.push(`${where}: ${srcTags.length} hashtag(s) became ${dstTags.length}.`);
    }

    const srcUrls = d.slideUrls ?? [];
    const dstUrls = e.mediaUrls ?? [];
    if (srcUrls.length !== dstUrls.length) {
      losses.push(
        `${where}: ${srcUrls.length} slide URL(s) became ${dstUrls.length} media URL(s).`,
      );
    } else if (srcUrls.join('|') !== dstUrls.join('|')) {
      losses.push(`${where}: slide URL order changed.`);
    }

    if (s.igMediaId !== e.igMediaId) {
      problems.push(`${where}: ig_media_id '${s.igMediaId}' became '${e.igMediaId}'.`);
    }
    if (s.attempts !== e.attempts) {
      problems.push(`${where}: attempts ${s.attempts} became ${e.attempts}.`);
    }
    if (!sameInstant(s.scheduledFor, e.scheduledFor)) {
      problems.push(`${where}: scheduled_for ${s.scheduledFor} became ${e.scheduledFor}.`);
    }
    if (!sameInstant(s.publishedAt, e.publishedAt)) {
      problems.push(`${where}: published_at ${s.publishedAt} became ${e.publishedAt}.`);
    }
  }

  console.log('Rows intentionally not migrated (v2 has no draft generation):');
  if (before.unscheduledDraftIds.length === 0) {
    console.log('  none — every draft had a schedule row.');
  } else {
    for (const id of before.unscheduledDraftIds) {
      const d = draftsById.get(id)!;
      console.log(`  draft #${id} [${d.status}] "${d.title ?? '(untitled)'}"`);
    }
  }
  console.log('');

  if (losses.length > 0) {
    console.log(`FIELD LOSSES (${losses.length}):`);
    for (const l of losses) console.log(`  ${l}`);
    console.log('');
  }
  if (problems.length > 0) {
    console.log(`PROBLEMS (${problems.length}):`);
    for (const p of problems) console.log(`  ${p}`);
    console.log('');
  }

  const ok = losses.length === 0 && problems.length === 0;
  console.log(
    ok ? 'RECONCILED: no field losses, no mismatches.' : 'DID NOT RECONCILE — see above.',
  );
  if (!ok) process.exitCode = 1;
}

function nonEmpty(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function sameInstant(a: string | Date | null, b: string | Date | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

async function count(table: string): Promise<number> {
  try {
    const rows = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`,
    );
    return rows[0]?.n ?? 0;
  } catch {
    // Table already dropped — that is information, not an error.
    return -1;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const beforeIdx = args.indexOf('--before');
  const afterIdx = args.indexOf('--after');

  if (beforeIdx >= 0) {
    await capture(args[beforeIdx + 1] ?? 'migration-snapshot.json');
  } else if (afterIdx >= 0) {
    await reconcile(args[afterIdx + 1] ?? 'migration-snapshot.json');
  } else {
    console.error('Usage: verify-migration --before <file> | --after <file>');
    process.exitCode = 1;
  }
  await closeDb();
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exit(1);
});
