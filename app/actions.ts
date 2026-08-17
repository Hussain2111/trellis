'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { enqueue } from '@/lib/jobs/queue';
import { setSettings, settingsSchema } from '@/lib/settings';
import { complete } from '@/lib/providers/llm';
import { smokeTierA, smokeTierB } from '@/lib/prompts';
import type { Tier } from '@/lib/providers/llm/types';

export async function saveSettingsAction(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(formData.entries());
  const partial = settingsSchema
    .partial()
    .parse({
      ...(raw.handle !== undefined ? { handle: String(raw.handle) } : {}),
      ...(raw.niche !== undefined ? { niche: String(raw.niche) } : {}),
      ...(raw.ollamaModel !== undefined ? { ollamaModel: String(raw.ollamaModel) } : {}),
      ...(raw.scanCooldownDays !== undefined
        ? { scanCooldownDays: Number(raw.scanCooldownDays) }
        : {}),
      ...(raw.analysisWindowDays !== undefined
        ? { analysisWindowDays: Number(raw.analysisWindowDays) }
        : {}),
      ...(raw.postsPerWeek !== undefined ? { postsPerWeek: Number(raw.postsPerWeek) } : {}),
      ...(raw.publishingMode !== undefined
        ? { publishingMode: String(raw.publishingMode) as 'manual' | 'api' }
        : {}),
      localOnlyVoiceAndChat: raw.localOnlyVoiceAndChat === 'on',
    });

  setSettings(partial);
  revalidatePath('/settings');
  revalidatePath('/');
}

export async function acknowledgePrivacyAction(): Promise<void> {
  setSettings({ privacyNoticeAcknowledgedAt: Math.floor(Date.now() / 1000) });
  revalidatePath('/');
  revalidatePath('/settings');
}

export async function enqueueSelftestAction(): Promise<void> {
  enqueue('noop', { steps: 5, sleepMs: 400 });
  revalidatePath('/');
}

const tierSchema = z.enum(['A', 'B']);

export interface SmokeTestOutcome {
  ok: boolean;
  detail: string;
  generatedBy?: string;
  degraded?: boolean;
  durationMs?: number;
}

/** Settings' "test this tier" button. One tiny real call, honestly reported. */
export async function smokeTestAction(tierInput: string): Promise<SmokeTestOutcome> {
  const parsed = tierSchema.safeParse(tierInput);
  if (!parsed.success) return { ok: false, detail: 'unknown tier' };
  const tier: Tier = parsed.data;
  const prompt = tier === 'A' ? smokeTierA : smokeTierB;

  try {
    const result = await complete({
      tier,
      operation: 'misc',
      system: prompt.system,
      prompt: prompt.render({}),
      schema: prompt.schema!,
      maxOutputTokens: 64,
      allowFallback: false,
    });
    return {
      ok: result.value.ok,
      detail: `mood: ${result.value.mood}`,
      generatedBy: result.generatedBy,
      degraded: result.degraded,
      durationMs: result.durationMs,
    };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}
