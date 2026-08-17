import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client';
import { settings } from '../db/schema';

/**
 * Typed key/value settings. Anything the user can change at runtime lives here;
 * anything that is a secret or a deployment concern lives in the environment.
 */

export const settingsSchema = z.object({
  handle: z.string().default(''),
  niche: z.string().default(''),
  /** Days between scans of the same account. */
  scanCooldownDays: z.number().int().positive().default(7),
  publishingMode: z.enum(['manual', 'api']).default('manual'),
  /** Analysis window in days. */
  analysisWindowDays: z.number().int().positive().default(30),
  /** Multiple of trailing median above which one of my posts counts as a winner. */
  outlierMultiplier: z.number().positive().default(2.5),
  imageProvider: z.enum(['none', 'pollinations']).default('none'),
  postsPerWeek: z.number().int().nonnegative().default(3),
  formatMix: z
    .object({ reel: z.number(), carousel: z.number(), image: z.number() })
    .default({ reel: 0.5, carousel: 0.35, image: 0.15 }),
  /** Ollama generation model, chosen by `npm run bench:llm`. */
  ollamaModel: z.string().default(''),
  ollamaEmbedModel: z.string().default('nomic-embed-text'),
  /** Set once the user has been shown the Gemini free-tier training notice. */
  privacyNoticeAcknowledgedAt: z.number().nullable().default(null),
  localOnlyVoiceAndChat: z.boolean().default(false),
  /** Rolling 24h publishing cap; verify against current Meta docs. */
  publishCapPer24h: z.number().int().positive().default(25),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

export function getSetting<K extends SettingKey>(key: K): Settings[K] {
  const row = db().select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return DEFAULT_SETTINGS[key];
  const parsed = settingsSchema.shape[key].safeParse(JSON.parse(row.value));
  return parsed.success ? (parsed.data as Settings[K]) : DEFAULT_SETTINGS[key];
}

export function getSettings(): Settings {
  const rows = db()
    .select()
    .from(settings)
    .where(inArray(settings.key, Object.keys(DEFAULT_SETTINGS)))
    .all();
  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      raw[row.key] = JSON.parse(row.value);
    } catch {
      // A corrupt row falls back to the default rather than taking the app down.
    }
  }
  const parsed = settingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export function setSetting<K extends SettingKey>(key: K, value: Settings[K]): void {
  const validated = settingsSchema.shape[key].parse(value);
  db()
    .insert(settings)
    .values({ key, value: JSON.stringify(validated), updatedAt: Math.floor(Date.now() / 1000) })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(validated), updatedAt: Math.floor(Date.now() / 1000) },
    })
    .run();
}

export function setSettings(partial: Partial<Settings>): void {
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) continue;
    setSetting(key as SettingKey, value as Settings[SettingKey]);
  }
}
