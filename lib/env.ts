import { z } from 'zod';

/**
 * Server-only environment. Never import this from a client component; the
 * runtime guard in `env()` turns that mistake into a loud error rather than a
 * leaked secret.
 *
 * Parsing is lazy and memoised so that a missing optional key (say, an Apify
 * token) surfaces where it is used rather than crashing the whole app at import.
 */

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

export const envSchema = z.object({
  // --- Database (Supabase Postgres) ----------------------------------------
  DATABASE_URL: z.string().min(1).default('postgres://postgres:postgres@localhost:5432/trellis'),

  // --- Deployment ---------------------------------------------------------
  // Base URL Apify's webhook calls back to. Falls back to Vercel's own
  // VERCEL_URL system variable in production; only set this to override it.
  APP_URL: z.string().optional(),

  // --- Model provider (Gemini free tier — the only LLM tier) ---------------
  LLM_PROVIDER: z.enum(['google', 'fake']).default('google'),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  GOOGLE_MODEL: z.string().default('gemini-3.6-flash'),

  // --- Scraping (Apify) -------------------------------------------------------
  APIFY_TOKEN: z.string().optional(),
  APIFY_ACTOR: z.string().default('apify/instagram-profile-scraper'),
  APIFY_HASHTAG_ACTOR: z.string().default('apify/instagram-hashtag-scraper'),
  // Only used by the manual follower snapshot behind the Unfollows tab.
  APIFY_FOLLOWERS_ACTOR: z.string().default('apify/instagram-profile-scraper'),
  // live = spend Apify credits. fixture = replay ./fixtures offline, zero cost.
  SCRAPE_MODE: z.enum(['live', 'fixture', 'fake']).default('fixture'),
  APIFY_MONTHLY_CREDIT_USD: z.coerce.number().nonnegative().default(5),
  APIFY_WEBHOOK_SECRET: z.string().optional(),

  // --- Instagram (Graph API publishing) --------------------------------------
  // Pinned deliberately, and surfaced on /settings. Verified live: requests
  // sent to v21.0 came back with v26.0 in every response URL — Meta silently
  // upgrades calls to a retired version. That is exactly how a renamed metric
  // (`impressions` → `views`, `plays` folded into it) turns real engagement
  // into nulls without anything noticing, so the version the app asks for and
  // the version it gets need to be comparable at a glance.
  GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v21.0'),
  IG_HANDLE: z.string().optional(),
  IG_USER_ID: z.string().optional(),
  IG_ACCESS_TOKEN: z.string().optional(),

  // --- Guards -----------------------------------------------------------------
  ALLOW_PAID_PROVIDERS: bool.default(false),
  ENABLE_IG_PUBLISHING: bool.default(false),

  // --- Cron auth ----------------------------------------------------------------
  // Sent as `Authorization: Bearer $CRON_SECRET` by Vercel's own cron caller
  // and by the GitHub Actions schedule. Required in production.
  CRON_SECRET: z.string().optional(),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (typeof window !== 'undefined') {
    throw new Error('lib/env.ts was imported from the browser. Secrets are server-only.');
  }
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(
      `Invalid environment:\n${detail}\n\nCopy .env.example to .env.local and fill it in.`,
    );
  }
  cached = parsed.data;
  return cached;
}

/** Test seam: force a specific env without touching process.env. */
export function __setEnvForTests(value: Env | null): void {
  cached = value;
}
