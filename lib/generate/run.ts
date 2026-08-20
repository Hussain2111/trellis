import { complete } from '../providers/llm';
import {
  buildOpportunitiesPayload,
  buildWeeklyPayload,
  type OpportunitiesPayload,
  type WeeklyPayload,
} from './payload';
import {
  OPPORTUNITIES_SYSTEM,
  buildOpportunitiesPrompt,
  opportunitiesSchema,
  type OpportunitiesResult,
} from '../prompts/opportunities.v1';
import {
  WEEKLY_SYSTEM,
  buildWeeklyPrompt,
  weeklySchema,
  type WeeklyResult,
} from '../prompts/weekly.v1';
import { validateInsights } from './validate';
import { currentWeekStart, writeGeneration } from './store';

/**
 * SQL computes, Gemini interprets, code validates, the result is cached.
 *
 * Nothing here can put an unbacked number on the screen: `validateInsights`
 * drops any insight asserting a figure absent from the payload, and a model
 * failure or a wholly-invalidated response falls back to the deterministic
 * output that was already built — labelled as unelaborated, never blank and
 * never fabricated.
 */

export interface GenerationOutcome {
  status: 'ok' | 'fallback';
  weekStart: string;
  kept: number;
  dropped: number;
  notes: string[];
}

export async function generateOpportunities(now: Date = new Date()): Promise<GenerationOutcome> {
  const weekStart = currentWeekStart(now);
  const payload = await buildOpportunitiesPayload(now);

  if (!payload) {
    return {
      status: 'fallback',
      weekStart,
      kept: 0,
      dropped: 0,
      notes: ['No account configured.'],
    };
  }
  if (payload.insufficient) {
    // Thin data never reaches the model at all.
    await writeGeneration({
      kind: 'opportunities',
      weekStart,
      payload,
      output: { insights: [] },
      status: 'fallback',
      validationNotes: [payload.insufficient],
      generatedBy: 'skipped',
    });
    return {
      status: 'fallback',
      weekStart,
      kept: 0,
      dropped: 0,
      notes: [payload.insufficient],
    };
  }

  try {
    const result = await complete<OpportunitiesResult>({
      operation: 'generate_opportunities',
      system: OPPORTUNITIES_SYSTEM,
      prompt: buildOpportunitiesPrompt(payload),
      schema: opportunitiesSchema,
      temperature: 0.3,
      maxOutputTokens: 2000,
    });

    const validated = validateInsights(result.value.insights, payload, (i) => ({
      prose: [i.finding, i.action],
      postIds: i.postIds,
    }));

    const status = validated.kept.length > 0 ? 'ok' : 'fallback';
    await writeGeneration({
      kind: 'opportunities',
      weekStart,
      payload,
      output: { insights: validated.kept },
      status,
      validationNotes: validated.notes,
      generatedBy: result.generatedBy,
    });

    return {
      status,
      weekStart,
      kept: validated.kept.length,
      dropped: validated.dropped.length,
      notes: validated.notes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeGeneration({
      kind: 'opportunities',
      weekStart,
      payload,
      output: { insights: [] },
      status: 'fallback',
      validationNotes: [`Generation failed: ${message}`],
      generatedBy: 'failed',
    });
    return { status: 'fallback', weekStart, kept: 0, dropped: 0, notes: [message] };
  }
}

export async function generateWeekly(now: Date = new Date()): Promise<GenerationOutcome> {
  const weekStart = currentWeekStart(now);
  const payload = await buildWeeklyPayload(now);

  if (!payload) {
    return {
      status: 'fallback',
      weekStart,
      kept: 0,
      dropped: 0,
      notes: ['No account configured.'],
    };
  }
  if (payload.insufficient) {
    await writeGeneration({
      kind: 'weekly',
      weekStart,
      payload,
      output: null,
      status: 'fallback',
      validationNotes: [payload.insufficient],
      generatedBy: 'skipped',
    });
    return { status: 'fallback', weekStart, kept: 0, dropped: 0, notes: [payload.insufficient] };
  }

  try {
    const result = await complete<WeeklyResult>({
      operation: 'generate_weekly',
      system: WEEKLY_SYSTEM,
      prompt: buildWeeklyPrompt(payload),
      schema: weeklySchema,
      temperature: 0.4,
      maxOutputTokens: 2000,
    });

    // The narrative blocks are validated as one unit: a single unbacked figure
    // anywhere in the recap invalidates the recap, because the reader cannot
    // tell which sentence was the wrong one.
    const prose = validateInsights(
      [result.value],
      payload,
      (r) => ({ prose: [r.headline, r.recap, r.trends], postIds: [] }),
      { requireCitations: false },
    );

    if (prose.kept.length === 0) {
      await writeGeneration({
        kind: 'weekly',
        weekStart,
        payload,
        output: null,
        status: 'fallback',
        validationNotes: prose.notes,
        generatedBy: result.generatedBy,
      });
      return { status: 'fallback', weekStart, kept: 0, dropped: 1, notes: prose.notes };
    }

    // Actions are validated individually, and may legitimately cite nothing
    // when they follow from the week rather than from a specific post.
    const actions = validateInsights(
      result.value.nextWeek,
      payload,
      (a) => ({ prose: [a.action, a.why], postIds: a.postIds }),
      { requireCitations: false },
    );

    await writeGeneration({
      kind: 'weekly',
      weekStart,
      payload,
      output: { ...result.value, nextWeek: actions.kept },
      status: 'ok',
      validationNotes: [...prose.notes, ...actions.notes],
      generatedBy: result.generatedBy,
    });

    return {
      status: 'ok',
      weekStart,
      kept: actions.kept.length,
      dropped: actions.dropped.length,
      notes: actions.notes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeGeneration({
      kind: 'weekly',
      weekStart,
      payload,
      output: null,
      status: 'fallback',
      validationNotes: [`Generation failed: ${message}`],
      generatedBy: 'failed',
    });
    return { status: 'fallback', weekStart, kept: 0, dropped: 0, notes: [message] };
  }
}

export type { OpportunitiesPayload, WeeklyPayload };
