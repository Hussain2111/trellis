import fs from 'node:fs';
import '../lib/bootstrap-env';

/**
 * Read-only first-contact probe for the Instagram Graph API.
 *
 * Deliberately standalone: it imports nothing from `lib/insights/graph.ts`,
 * because the whole point is to find out where the app's model of the API
 * disagrees with the API. A probe built on the mappers under test would
 * inherit their assumptions and confirm them.
 *
 * Every response is printed raw and unmapped. Nothing is written anywhere.
 *
 *   npx tsx scripts/probe-graph.ts                 # probe + reconciliation table
 *   npx tsx scripts/probe-graph.ts --json out.json # also dump raw responses
 *
 * Needs IG_USER_ID and IG_ACCESS_TOKEN in the environment. The token must
 * carry instagram_manage_insights and instagram_manage_comments, or the
 * insight and comment sections will come back empty rather than erroring —
 * which is exactly the failure this probe exists to make visible.
 */

const API_VERSION = process.env.GRAPH_API_VERSION ?? 'v21.0';
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;

/** Metric names the app asks for today. One request each, so one retired name doesn't mask the rest. */
const MEDIA_METRICS = [
  'reach',
  'views',
  'saved',
  'shares',
  'likes',
  'comments',
  'total_interactions',
];
const ACCOUNT_METRICS = [
  'reach',
  'views',
  'profile_views',
  'accounts_engaged',
  'total_interactions',
];

/** Fields `fetchOwnMedia` requests. `shortcode` is the one most likely to be absent. */
const MEDIA_FIELDS = [
  'id',
  'shortcode',
  'caption',
  'media_type',
  'media_product_type',
  'timestamp',
  'permalink',
  'thumbnail_url',
  'media_url',
  'like_count',
  'comments_count',
  'children{id}',
];

type Verdict = 'present' | 'empty' | 'absent' | 'error';

interface Finding {
  section: string;
  name: string;
  verdict: Verdict;
  detail: string;
}

const findings: Finding[] = [];
const raw: Record<string, unknown> = {};

async function call(
  path: string,
  params: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', TOKEN);

  const res = await fetch(url);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // keep the raw text
  }
  return { ok: res.ok, status: res.status, body };
}

function errorMessage(body: unknown): string {
  const err = (body as { error?: { message?: string; code?: number; error_subcode?: number } })
    ?.error;
  if (!err)
    return typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200);
  return `[${err.code ?? '?'}${err.error_subcode ? `/${err.error_subcode}` : ''}] ${err.message ?? 'no message'}`;
}

function show(label: string, body: unknown): void {
  console.log(`\n--- ${label} ${'-'.repeat(Math.max(0, 66 - label.length))}`);
  console.log(JSON.stringify(body, null, 2));
  raw[label] = body;
}

const IG_USER_ID = process.env.IG_USER_ID ?? '';
const TOKEN = process.env.IG_ACCESS_TOKEN ?? '';

async function probeToken(): Promise<void> {
  const res = await call('debug_token', { input_token: TOKEN });
  show('debug_token', res.body);

  const data = (
    res.body as { data?: { scopes?: string[]; is_valid?: boolean; expires_at?: number } }
  )?.data;
  const scopes = data?.scopes ?? [];
  const required = [
    'instagram_basic',
    'instagram_manage_insights',
    'instagram_manage_comments',
    'pages_read_engagement',
    'pages_show_list',
  ];
  // Sixth scope: only the auto-publish path uses it, but a token regenerated
  // for the insight scopes and missing this one breaks publishing silently.
  const publishing = ['instagram_content_publish'];

  for (const scope of [...required, ...publishing]) {
    findings.push({
      section: 'token scopes',
      name: publishing.includes(scope) ? `${scope} (auto-publish only)` : scope,
      verdict: scopes.includes(scope) ? 'present' : 'absent',
      detail: scopes.length === 0 ? 'debug_token reported no scopes at all' : '',
    });
  }
}

async function probeAccount(): Promise<void> {
  const fields = 'username,followers_count,follows_count,media_count,name,biography';
  const res = await call(IG_USER_ID, { fields });
  show('GET /{ig-user-id}', res.body);

  if (!res.ok) {
    findings.push({
      section: 'account edge',
      name: fields,
      verdict: 'error',
      detail: errorMessage(res.body),
    });
    return;
  }

  const body = res.body as Record<string, unknown>;
  for (const field of fields.split(',')) {
    findings.push({
      section: 'account edge',
      name: field,
      verdict: field in body ? (body[field] === null ? 'empty' : 'present') : 'absent',
      detail: field in body ? JSON.stringify(body[field]).slice(0, 60) : 'not in response',
    });
  }
}

async function probeAccountInsights(): Promise<void> {
  for (const metric of ACCOUNT_METRICS) {
    const res = await call(`${IG_USER_ID}/insights`, {
      metric,
      period: 'day',
      metric_type: 'total_value',
    });
    show(`GET /{ig-user-id}/insights?metric=${metric}`, res.body);
    findings.push({
      section: 'account insights',
      name: metric,
      verdict: res.ok ? verdictFromInsight(res.body) : 'error',
      detail: res.ok ? '' : errorMessage(res.body),
    });
  }

  // The one the Unfollows free layer depends on, and the one most likely to
  // be refused: Meta serves it only above 100 followers and has moved its
  // shape between versions.
  const res = await call(`${IG_USER_ID}/insights`, {
    metric: 'follows_and_unfollows',
    period: 'day',
    metric_type: 'total_value',
    breakdown: 'follow_type',
  });
  show('GET /{ig-user-id}/insights?metric=follows_and_unfollows', res.body);
  findings.push({
    section: 'account insights',
    name: 'follows_and_unfollows (breakdown=follow_type)',
    verdict: res.ok ? verdictFromInsight(res.body) : 'error',
    detail: res.ok
      ? `breakdown shape: ${JSON.stringify(
          (res.body as { data?: { total_value?: unknown }[] })?.data?.[0]?.total_value,
        ).slice(0, 200)}`
      : errorMessage(res.body),
  });
}

function verdictFromInsight(body: unknown): Verdict {
  const data = (body as { data?: unknown[] })?.data;
  if (!Array.isArray(data) || data.length === 0) return 'empty';
  const row = data[0] as { total_value?: { value?: unknown }; values?: { value?: unknown }[] };
  const value = row.total_value?.value ?? row.values?.[0]?.value;
  return value == null ? 'empty' : 'present';
}

interface MediaRow extends Record<string, unknown> {
  id: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  shortcode?: string;
}

async function probeMedia(): Promise<MediaRow[]> {
  const res = await call(`${IG_USER_ID}/media`, { fields: MEDIA_FIELDS.join(','), limit: '10' });
  show('GET /{ig-user-id}/media', res.body);

  if (!res.ok) {
    findings.push({
      section: 'media edge',
      name: 'request',
      verdict: 'error',
      detail: errorMessage(res.body),
    });
    return [];
  }

  const rows = ((res.body as { data?: MediaRow[] })?.data ?? []) as MediaRow[];
  const first = rows[0];

  for (const field of MEDIA_FIELDS) {
    const key = field.replace(/\{.*\}$/, '');
    const present = first ? key in first : false;
    findings.push({
      section: 'media edge',
      name: key,
      verdict: !first ? 'empty' : present ? 'present' : 'absent',
      detail: !first
        ? 'no media returned'
        : present
          ? String(first[key]).slice(0, 60)
          : 'not in response',
    });
  }

  // The join key question: every existing scraped `posts` row is keyed by
  // shortcode, so if the media edge doesn't serve one, something has to
  // derive it or the two halves of the history never join.
  if (first && !('shortcode' in first)) {
    const derived = first.permalink?.match(/\/(?:p|reel|tv)\/([^/?]+)/)?.[1];
    findings.push({
      section: 'join key',
      name: 'shortcode fallback from permalink',
      verdict: derived ? 'present' : 'absent',
      detail: derived
        ? `permalink parse yields "${derived}" — usable as the join key`
        : `NO usable join key: permalink was ${JSON.stringify(first.permalink)}`,
    });
  }

  console.log(
    `\nMedia types returned: ${rows.map((r) => `${r.media_type}/${r.media_product_type}`).join(', ')}`,
  );
  return rows;
}

function pick(rows: MediaRow[], kind: 'reel' | 'carousel' | 'image'): MediaRow | undefined {
  if (kind === 'reel') return rows.find((r) => r.media_product_type === 'REELS');
  if (kind === 'carousel') return rows.find((r) => r.media_type === 'CAROUSEL_ALBUM');
  return rows.find((r) => r.media_type === 'IMAGE' && r.media_product_type !== 'REELS');
}

/**
 * Metric availability differs by media type, and this is where the docs are
 * least reliable. If reels don't serve `saved` but images do, that has to be a
 * known-null per format — otherwise Post Analytics and Opportunities both rank
 * formats against each other on incomplete data and look confidently wrong.
 */
async function probeMediaInsights(rows: MediaRow[]): Promise<void> {
  for (const kind of ['reel', 'carousel', 'image'] as const) {
    const media = pick(rows, kind);
    if (!media) {
      findings.push({
        section: `media insights (${kind})`,
        name: '—',
        verdict: 'absent',
        detail: 'no media of this type in the last 10 posts; re-run when one exists',
      });
      continue;
    }

    for (const metric of MEDIA_METRICS) {
      const res = await call(`${media.id}/insights`, { metric });
      findings.push({
        section: `media insights (${kind})`,
        name: metric,
        verdict: res.ok ? verdictFromInsight(res.body) : 'error',
        detail: res.ok ? '' : errorMessage(res.body),
      });
      if (!res.ok || verdictFromInsight(res.body) !== 'present') {
        show(`GET /${kind}/insights?metric=${metric}`, res.body);
      }
    }

    // Also the batched form the app actually uses first, to see whether one
    // bad name takes the whole request down.
    const batched = await call(`${media.id}/insights`, { metric: MEDIA_METRICS.join(',') });
    show(`GET /${kind}/insights (batched, all metrics)`, batched.body);
    findings.push({
      section: `media insights (${kind})`,
      name: 'BATCHED request',
      verdict: batched.ok ? 'present' : 'error',
      detail: batched.ok
        ? 'batched request succeeds — the per-metric retry path is not needed here'
        : `batched request fails, per-metric retry required: ${errorMessage(batched.body)}`,
    });
  }
}

async function probeComments(rows: MediaRow[]): Promise<void> {
  const media = rows[0];
  if (!media) return;

  const res = await call(`${media.id}/comments`, {
    fields: 'id,username,text,like_count,timestamp',
    limit: '5',
  });
  show('GET /{ig-media-id}/comments', res.body);

  if (!res.ok) {
    findings.push({
      section: 'comments',
      name: 'request',
      verdict: 'error',
      detail: errorMessage(res.body),
    });
    return;
  }

  const data = (res.body as { data?: Record<string, unknown>[] })?.data ?? [];
  const paging = (res.body as { paging?: unknown })?.paging;
  const first = data[0];

  for (const field of ['id', 'username', 'text', 'like_count', 'timestamp']) {
    findings.push({
      section: 'comments',
      name: field,
      verdict: !first ? 'empty' : field in first ? 'present' : 'absent',
      detail: !first ? 'no comments on the newest post — try another' : '',
    });
  }
  findings.push({
    section: 'comments',
    name: 'paging',
    verdict: paging ? 'present' : 'absent',
    detail: JSON.stringify(paging ?? null).slice(0, 160),
  });
}

function table(): void {
  console.log(`\n\n${'='.repeat(100)}`);
  console.log(`RECONCILIATION — Graph API ${API_VERSION}`);
  console.log(`Probed at ${new Date().toISOString()}`);
  console.log('='.repeat(100));

  let section = '';
  for (const f of findings) {
    if (f.section !== section) {
      section = f.section;
      console.log(`\n${section}`);
      console.log('-'.repeat(100));
    }
    const mark = { present: 'OK  ', empty: 'EMPTY', absent: 'ABSENT', error: 'ERROR' }[f.verdict];
    console.log(`  ${mark.padEnd(7)} ${f.name.padEnd(42)} ${f.detail}`);
  }

  const bad = findings.filter((f) => f.verdict !== 'present');
  console.log(`\n${'='.repeat(100)}`);
  console.log(`${findings.length - bad.length}/${findings.length} expectations met.`);
  if (bad.length > 0) {
    console.log(`\n${bad.length} need attention — each one is a mapper or a fixture to fix:`);
    for (const f of bad) console.log(`  [${f.verdict}] ${f.section} / ${f.name} ${f.detail}`);
  }
}

async function main(): Promise<void> {
  if (!IG_USER_ID || !TOKEN) {
    console.error(
      'IG_USER_ID and IG_ACCESS_TOKEN must be set. This probe reads only — it writes nothing.',
    );
    process.exit(1);
  }

  console.log(`Probing Graph API ${API_VERSION} as ${IG_USER_ID}. Read-only.\n`);

  await probeToken();
  await probeAccount();
  await probeAccountInsights();
  const rows = await probeMedia();
  await probeMediaInsights(rows);
  await probeComments(rows);
  table();

  const jsonIdx = process.argv.indexOf('--json');
  if (jsonIdx >= 0) {
    const out = process.argv[jsonIdx + 1] ?? 'graph-probe.json';
    fs.writeFileSync(out, JSON.stringify({ apiVersion: API_VERSION, findings, raw }, null, 2));
    console.log(`\nRaw responses written to ${out}.`);
    console.log('NOTE: that file contains your account data. Do not commit it.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
