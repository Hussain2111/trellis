import { z } from 'zod';

/**
 * Server-only environment. The runtime guard in `env()` turns an accidental
 * client import into a loud error rather than a leaked secret.
 *
 * Parsing is lazy and memoised so a missing optional key surfaces where it is
 * used rather than crashing the whole app at import time.
 *
 * Everything here is rendered on /settings from the *resolved* values the
 * running function actually sees. On the previous build that page turned out
 * to be a more reliable way to confirm a Vercel environment change had taken
 * effect than the Vercel dashboard itself.
 */

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

export const envSchema = z.object({
  // --- Database (Supabase Postgres) -----------------------------------------
  // The connection *pooler* string, transaction mode, prepared statements off.
  // Serverless functions are short-lived and numerous; a direct connection's
  // limit cannot absorb that. The direct hostname is also IPv6-only on newer
  // Supabase projects and is not reachable everywhere.
  DATABASE_URL: z.string().min(1).default('postgres://postgres:postgres@localhost:5432/trellis'),

  // --- Deployment -----------------------------------------------------------
  APP_URL: z.string().optional(),

  // --- Instagram Graph API --------------------------------------------------
  // Pinned deliberately and surfaced on /settings. On the previous build,
  // requests sent to v21.0 came back with v26.0 in every response URL — Meta
  // silently upgrades calls to a retired version, which is exactly how a
  // renamed metric turns real engagement into nulls with nothing noticing.
  GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v21.0'),
  IG_HANDLE: z.string().optional(),
  IG_USER_ID: z.string().optional(),
  IG_ACCESS_TOKEN: z.string().optional(),

  // --- Model provider -------------------------------------------------------
  // No model name appears outside lib/model/provider.ts. These are the only
  // places one is written down.
  MODEL_PRIMARY: z.string().default('google:gemini-3.6-flash'),
  MODEL_FALLBACK: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  // Other lanes. Set the one whose provider appears in MODEL_PRIMARY or
  // MODEL_FALLBACK; the rest stay unset and cost nothing. All speak the OpenAI
  // wire format, so they share one adapter — see lib/model/provider.ts.
  GROQ_API_KEY: z.string().optional(),
  GROQ_CALLS_PER_MINUTE: z.coerce.number().int().min(1).optional(),
  GROQ_CALLS_PER_DAY: z.coerce.number().int().min(1).optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  TOGETHER_API_KEY: z.string().optional(),
  CEREBRAS_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  /**
   * Provider requests allowed per minute. Configuration, not a constant,
   * because it is a property of the plan rather than of the code — and it is
   * small enough on a free tier that a single question can spend it.
   * Observed value and date live in docs/quota.md.
   */
  MODEL_CALLS_PER_MINUTE: z.coerce.number().int().min(1).default(5),
  /**
   * Provider requests allowed per day, across chat and card generation.
   *
   * Twenty, observed. Not a self-imposed ceiling — this is the free tier's
   * actual RPD for `gemini-3.6-flash`, and it is the binding constraint on the
   * whole product: a question costs up to four requests, so a day is about five
   * questions. The earlier default of 200 was invented before the number was
   * known and would not have stopped anything.
   */
  MODEL_CALLS_PER_DAY: z.coerce.number().int().min(1).default(20),

  // --- Cron auth ------------------------------------------------------------
  // Sent as `Authorization: Bearer $CRON_SECRET` by Vercel's own cron caller
  // and by the GitHub Actions schedules. Required in production; when unset in
  // local development the guard no-ops.
  CRON_SECRET: z.string().optional(),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * A variable set to nothing is a variable that is not set.
 *
 * `.env` files are full of `KEY=` — a line left blank rather than deleted, or
 * one a hosting dashboard wrote for a field nobody filled in. Zod sees an empty
 * string, not `undefined`, so a `.default()` never applies and a numeric field
 * coerces `''` to `0` and then fails its own minimum. The whole environment
 * then refuses to parse, `env()` throws, and every route that touches it
 * returns a bodiless 500.
 *
 * That is exactly how `MODEL_CALLS_PER_MINUTE=` turned the chat into "Could not
 * reach the server." Blank means absent, here, once, for every key.
 */
function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

export function env(): Env {
  if (typeof window !== 'undefined') {
    throw new Error('lib/env.ts was imported from the browser. Secrets are server-only.');
  }
  if (cached) return cached;
  const parsed = envSchema.safeParse(withoutBlanks(process.env));
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
export function __setEnvForTests(value: Partial<Env> | null): void {
  cached = value ? (envSchema.parse({ ...withoutBlanks(process.env), ...value }) as Env) : null;
}
