import { z } from 'zod';

/**
 * Server-only environment. Never import this from a client component; the
 * runtime guard in `env()` turns that mistake into a loud error rather than a
 * leaked secret. (We can't use the `server-only` package here because the
 * worker and benchmark run as plain Node scripts, where it throws.)
 *
 * Parsing is lazy and memoised so that a missing optional key (say, an Apify
 * token) surfaces where it is used rather than crashing the whole app at import.
 */

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

export const envSchema = z.object({
  LLM_TIER_A: z.enum(['google', 'fake']).default('google'),
  LLM_TIER_B: z.enum(['ollama', 'fake']).default('ollama'),

  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  GOOGLE_MODEL: z.string().default('gemini-2.5-flash'),
  GOOGLE_MODEL_LITE: z.string().default('gemini-2.5-flash-lite'),

  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default(''),
  OLLAMA_EMBED_MODEL: z.string().default('nomic-embed-text'),
  OLLAMA_KEEP_ALIVE: z.string().default('5m'),
  TIER_B_MAX_PROMPT_TOKENS: z.coerce.number().int().positive().default(800),

  IMAGE_PROVIDER: z.enum(['none', 'pollinations', 'fake']).default('none'),

  APIFY_TOKEN: z.string().optional(),
  APIFY_ACTOR: z.string().default('apify/instagram-scraper'),
  SCRAPE_MODE: z.enum(['live', 'fixture', 'fake']).default('fixture'),
  APIFY_MONTHLY_CREDIT_USD: z.coerce.number().nonnegative().default(5),

  IG_HANDLE: z.string().optional(),
  IG_USER_ID: z.string().optional(),
  IG_ACCESS_TOKEN: z.string().optional(),

  ENABLE_TRANSCRIPTION: bool.default(true),
  TRANSCRIPTION_CAP: z.coerce.number().int().positive().default(150),
  WHISPER_BIN: z.string().optional(),
  WHISPER_MODEL_PATH: z.string().optional(),

  ALLOW_PAID_PROVIDERS: bool.default(false),
  ENABLE_IG_PUBLISHING: bool.default(false),
  LOCAL_ONLY_VOICE_AND_CHAT: bool.default(false),

  DATABASE_PATH: z.string().default('./data/app.db'),
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
    throw new Error(`Invalid environment:\n${detail}\n\nCopy .env.example to .env.local and fill it in.`);
  }
  cached = parsed.data;
  return cached;
}

/** Test seam: force a specific env without touching process.env. */
export function __setEnvForTests(value: Env | null): void {
  cached = value;
}
