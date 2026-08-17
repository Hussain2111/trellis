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
  GOOGLE_MODEL_LITE: z.string().default('gemini-2.5-flash-lite'),

  // --- Images ---------------------------------------------------------------
  // none = deterministic gradients only (fully functional).
  // pollinations = free HTTP endpoint, no key, no SLA; degrades to gradient.
  IMAGE_PROVIDER: z.enum(['none', 'pollinations', 'fake']).default('none'),

  // --- Scraping (Apify) -------------------------------------------------------
  APIFY_TOKEN: z.string().optional(),
  APIFY_ACTOR: z.string().default('apify/instagram-profile-scraper'),
  APIFY_HASHTAG_ACTOR: z.string().default('apify/instagram-hashtag-scraper'),
  // live = spend Apify credits. fixture = replay ./fixtures offline, zero cost.
  SCRAPE_MODE: z.enum(['live', 'fixture', 'fake']).default('fixture'),
  APIFY_MONTHLY_CREDIT_USD: z.coerce.number().nonnegative().default(5),
  APIFY_WEBHOOK_SECRET: z.string().optional(),

  // --- Instagram (Graph API publishing) --------------------------------------
  IG_HANDLE: z.string().optional(),
  IG_USER_ID: z.string().optional(),
  IG_ACCESS_TOKEN: z.string().optional(),

  // --- Guards -----------------------------------------------------------------
  ALLOW_PAID_PROVIDERS: bool.default(false),
  ENABLE_IG_PUBLISHING: bool.default(false),

  // --- Vercel Cron auth ---------------------------------------------------------
  CRON_SECRET: z.string().optional(),

  // --- Supabase Storage (rendered slide PNGs) -------------------------------
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('trellis-assets'),

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
