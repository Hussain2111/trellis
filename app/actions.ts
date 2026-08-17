'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { drafts, schedule } from '@/lib/db/schema';
import { enqueue } from '@/lib/jobs/queue';
import { setSettings, settingsSchema, getSettings } from '@/lib/settings';
import { complete } from '@/lib/providers/llm';
import { smokeTierA, smokeTierB } from '@/lib/prompts';
import { getScraper } from '@/lib/providers';
import { isScanDue, listAccounts, removeAccount, upsertAccount } from '@/lib/ingest/upsert';
import { renameArchetype } from '@/lib/analysis/archetypes';
import { activateVoiceVersion, activeVoice, saveVoice } from '@/lib/analysis/voice';
import { voiceFieldsSchema } from '@/lib/prompts/voice-profile.v1';
import { draftRewrite, type DraftOutput } from '@/lib/prompts/draft-generation.v1';
import { voiceBlock } from '@/lib/analysis/voice';
import { latestAnalysis } from '@/lib/jobs/handlers/analysis';
import { markPosted, scheduleDraft, unschedule } from '@/lib/jobs/handlers/publish';
import { zipAssets } from '@/lib/publish/notify';
import { createThread, deleteThread } from '@/lib/chat/threads';
import type { Tier } from '@/lib/providers/llm/types';

function refresh(...paths: string[]): void {
  for (const p of ['/', ...paths]) revalidatePath(p);
}

// --- settings ---------------------------------------------------------------

export async function saveSettingsAction(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(formData.entries());
  const numeric = (key: string): Record<string, number> =>
    raw[key] === undefined ? {} : { [key]: Number(raw[key]) };
  const text = (key: string): Record<string, string> =>
    raw[key] === undefined ? {} : { [key]: String(raw[key]) };

  setSettings(
    settingsSchema.partial().parse({
      ...text('handle'),
      ...text('niche'),
      ...text('ollamaModel'),
      ...numeric('scanCooldownDays'),
      ...numeric('analysisWindowDays'),
      ...numeric('postsPerWeek'),
      ...numeric('outlierMultiplier'),
      ...(raw.publishingMode ? { publishingMode: String(raw.publishingMode) as 'manual' } : {}),
      localOnlyVoiceAndChat: raw.localOnlyVoiceAndChat === 'on',
    }),
  );
  refresh('/settings');
}

export async function acknowledgePrivacyAction(): Promise<void> {
  setSettings({ privacyNoticeAcknowledgedAt: Math.floor(Date.now() / 1000) });
  refresh('/settings');
}

// --- accounts ---------------------------------------------------------------

export async function addAccountAction(formData: FormData): Promise<{ error?: string }> {
  const handle = String(formData.get('handle') ?? '').trim();
  const role = String(formData.get('role') ?? 'competitor') as 'self' | 'competitor';
  if (!handle) return { error: 'Enter a handle.' };

  // Exactly one account is mine. Promoting a new one demotes the old.
  if (role === 'self') {
    for (const existing of listAccounts('self')) {
      if (existing.handle !== handle.replace(/^@/, '').toLowerCase()) {
        upsertAccount({ handle: existing.handle, role: 'competitor' });
      }
    }
    setSettings({ handle: handle.replace(/^@/, '').toLowerCase() });
  }

  upsertAccount({ handle, role });
  refresh('/competitors', '/settings');
  return {};
}

export async function removeAccountAction(id: number): Promise<void> {
  removeAccount(id);
  refresh('/competitors');
}

export interface ScanEstimate {
  handle: string;
  items: number;
  costUsd: number;
  affordable: boolean;
  note: string;
  cooldownBlocked: boolean;
}

/**
 * Shown before any scan runs. Scraping is the only thing here that can consume
 * a finite resource, so it never starts without the user seeing the price.
 */
export async function estimateScanAction(accountId: number, limit = 100): Promise<ScanEstimate> {
  const account = listAccounts().find((a) => a.id === accountId);
  if (!account) return { handle: '?', items: 0, costUsd: 0, affordable: false, note: 'Account not found.', cooldownBlocked: false };

  const settings = getSettings();
  const estimate = await getScraper().estimate({ handle: account.handle, limit });
  const due = isScanDue(account, settings.scanCooldownDays);

  return {
    handle: account.handle,
    items: estimate.items,
    costUsd: estimate.costUsd,
    affordable: estimate.affordable,
    note: estimate.note,
    cooldownBlocked: !due,
  };
}

export async function scanAccountAction(
  accountId: number,
  limit = 100,
  force = false,
): Promise<{ jobId?: number; error?: string }> {
  const estimate = await estimateScanAction(accountId, limit);
  if (!estimate.affordable) return { error: estimate.note };
  if (estimate.cooldownBlocked && !force) {
    return { error: `@${estimate.handle} was scanned recently. Use force if you really want to spend the credits.` };
  }
  const jobId = enqueue('scan_account', { accountId, limit, incremental: true });
  refresh('/posts', '/competitors');
  return { jobId: jobId ?? undefined };
}

// --- pipeline ---------------------------------------------------------------

export async function runJobAction(type: string): Promise<{ jobId?: number; error?: string }> {
  const settings = getSettings();
  switch (type) {
    case 'compute_features':
      return { jobId: enqueue('compute_features', {}) ?? undefined };
    case 'transcribe_reels':
      return { jobId: enqueue('transcribe_reels', { cap: Number(process.env.TRANSCRIPTION_CAP ?? 150) }) ?? undefined };
    case 'embed_posts':
      return { jobId: enqueue('embed_posts', {}) ?? undefined };
    case 'cluster_posts':
      return { jobId: enqueue('cluster_posts', {}) ?? undefined };
    case 'run_analysis':
      return { jobId: enqueue('run_analysis', { windowDays: settings.analysisWindowDays }) ?? undefined };
    case 'build_voice_profile':
      return { jobId: enqueue('build_voice_profile', {}) ?? undefined };
    default:
      return { error: `unknown job type ${type}` };
  }
}

export async function generateDraftsAction(count?: number): Promise<{ jobId?: number; error?: string }> {
  const analysis = latestAnalysis();
  if (!analysis) return { error: 'Run a gap analysis first — drafts are written against a gap.' };
  const jobId = enqueue('generate_drafts', { analysisId: analysis.id, count: count ?? 12 });
  refresh('/drafts');
  return { jobId: jobId ?? undefined };
}

export async function enqueueSelftestAction(): Promise<void> {
  enqueue('noop', { steps: 5, sleepMs: 400 });
  refresh();
}

// --- archetypes -------------------------------------------------------------

export async function renameArchetypeAction(formData: FormData): Promise<void> {
  const id = Number(formData.get('id'));
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  if (!id || !name) return;
  renameArchetype(id, name, description || undefined);
  refresh('/archetypes');
}

// --- voice ------------------------------------------------------------------

export async function saveVoiceAction(formData: FormData): Promise<void> {
  const markdown = String(formData.get('markdown') ?? '').trim();
  if (markdown.length < 20) return;
  const current = activeVoice();
  const fields = voiceFieldsSchema.safeParse(current?.fields ?? {});
  saveVoice({
    markdown,
    fields: fields.success
      ? fields.data
      : voiceFieldsSchema.parse({
          tone: '',
          sentence_rhythm: '',
          vocabulary: [],
          recurring_phrases: [],
          banned_words: [],
          cta_style: '',
          emoji_policy: '',
          formatting_habits: '',
          recurring_subjects: [],
        }),
    generatedBy: 'you',
    editedByUser: true,
  });
  refresh('/voice');
}

export async function activateVoiceAction(id: number): Promise<void> {
  activateVoiceVersion(id);
  refresh('/voice');
}

// --- drafts -----------------------------------------------------------------

export async function updateDraftAction(formData: FormData): Promise<void> {
  const id = Number(formData.get('id'));
  if (!id) return;
  const hashtags = String(formData.get('hashtags') ?? '')
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#/, ''))
    .filter(Boolean);

  db()
    .update(drafts)
    .set({
      title: String(formData.get('title') ?? ''),
      hook: String(formData.get('hook') ?? ''),
      caption: String(formData.get('caption') ?? ''),
      cta: String(formData.get('cta') ?? ''),
      hashtags,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(drafts.id, id))
    .run();
  refresh('/drafts', `/drafts/${id}`);
}

export async function setDraftStatusAction(id: number, status: string): Promise<void> {
  db()
    .update(drafts)
    .set({ status: status as 'draft', updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(drafts.id, id))
    .run();
  refresh('/drafts', `/drafts/${id}`);
}

/** "Make it more ___", holding the voice profile fixed. */
export async function rewriteDraftAction(
  id: number,
  instruction: string,
): Promise<{ error?: string }> {
  const draft = db().select().from(drafts).where(eq(drafts.id, id)).get();
  if (!draft) return { error: 'Draft not found.' };
  if (!instruction.trim()) return { error: 'Say what to change.' };

  try {
    const result = await complete<DraftOutput>({
      tier: 'A',
      operation: 'draft_generation',
      system: draftRewrite.system,
      prompt: draftRewrite.render({
        voice: voiceBlock(),
        instruction,
        draft: JSON.stringify(
          {
            format: draft.format,
            title: draft.title,
            hook: draft.hook,
            body: draft.body,
            caption: draft.caption,
            hashtags: draft.hashtags,
            cta: draft.cta,
            rationale: draft.rationale,
            evidence: draft.evidence,
            pattern_index: draft.patternIndex ?? 0,
          },
          null,
          2,
        ),
      }),
      schema: draftRewrite.schema!,
      maxOutputTokens: 3072,
      temperature: 0.7,
    });

    db()
      .update(drafts)
      .set({
        title: result.value.title,
        hook: result.value.hook,
        body: result.value.body,
        caption: result.value.caption,
        hashtags: result.value.hashtags,
        cta: result.value.cta,
        rationale: result.value.rationale,
        generatedBy: `${result.generatedBy}${result.degraded ? ' (degraded)' : ''}`,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(drafts.id, id))
      .run();

    refresh('/drafts', `/drafts/${id}`);
    return {};
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export async function renderSlidesAction(draftId: number): Promise<{ jobId?: number }> {
  const jobId = enqueue('render_slides', { draftId });
  refresh(`/drafts/${draftId}`);
  return { jobId: jobId ?? undefined };
}

// --- scheduling -------------------------------------------------------------

export async function scheduleDraftAction(formData: FormData): Promise<{ error?: string }> {
  const draftId = Number(formData.get('draftId'));
  const when = String(formData.get('scheduledFor') ?? '');
  if (!draftId || !when) return { error: 'Pick a date and time.' };

  const scheduledFor = Math.floor(new Date(when).getTime() / 1000);
  if (!Number.isFinite(scheduledFor)) return { error: 'That date did not parse.' };
  if (scheduledFor <= Math.floor(Date.now() / 1000)) return { error: 'That time is in the past.' };

  scheduleDraft(draftId, scheduledFor, getSettings().publishingMode);
  refresh('/calendar', '/drafts', `/drafts/${draftId}`);
  return {};
}

export async function unscheduleAction(scheduleId: number): Promise<void> {
  unschedule(scheduleId);
  refresh('/calendar', '/drafts');
}

export async function markPostedAction(scheduleId: number): Promise<void> {
  markPosted(scheduleId);
  refresh('/calendar', '/drafts');
}

export async function zipAssetsAction(draftId: number): Promise<{ path?: string; error?: string }> {
  const out = await zipAssets(draftId);
  return out ? { path: out } : { error: 'No rendered assets yet — render the slides first.' };
}

// --- chat -------------------------------------------------------------------

export async function createThreadAction(): Promise<number> {
  const id = createThread();
  refresh('/chat');
  return id;
}

export async function deleteThreadAction(id: number): Promise<void> {
  deleteThread(id);
  refresh('/chat');
}

// --- diagnostics ------------------------------------------------------------

const tierSchema = z.enum(['A', 'B']);

export interface SmokeTestOutcome {
  ok: boolean;
  detail: string;
  generatedBy?: string;
  degraded?: boolean;
  durationMs?: number;
}

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

export async function cancelScheduleRowAction(id: number): Promise<void> {
  db().delete(schedule).where(eq(schedule.id, id)).run();
  refresh('/calendar');
}
