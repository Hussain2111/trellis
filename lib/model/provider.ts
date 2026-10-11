import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, type LanguageModel } from 'ai';
import { env } from '../env';
import { diagnosticFetch } from './diagnostics';

/**
 * The only module in this codebase that names a model.
 *
 * Free model catalogues change without notice — providers have deleted models
 * that running code depended on. So the model is configuration, the failover
 * lane is configuration, and swapping either is an environment change rather
 * than a deploy. The abstraction costs almost nothing now and is expensive to
 * retrofit.
 */

export type Purpose = 'chat' | 'cards';

/** `provider:model`, e.g. `google:gemini-3.6-flash`. */
export interface ModelRef {
  provider: string;
  modelId: string;
}

export function parseModelRef(value: string): ModelRef {
  const index = value.indexOf(':');
  if (index <= 0 || index === value.length - 1) {
    throw new Error(`Model must be "provider:model", got "${value}".`);
  }
  return { provider: value.slice(0, index), modelId: value.slice(index + 1) };
}

/**
 * Every lane, from one adapter.
 *
 * Groq, DeepSeek, OpenRouter, Together, Cerebras and Mistral all speak the
 * OpenAI wire format, so they are a base URL and a key rather than six SDK
 * packages. Google is the exception and keeps its own adapter, because its API
 * is not OpenAI-shaped.
 *
 * The point of this table is that changing provider is an environment change.
 * `MODEL_PRIMARY=groq:llama-3.3-70b-versatile` plus `GROQ_API_KEY` is the whole
 * migration — no code, no deploy of new code, and the quota guards, the ledger
 * and the validator all carry over untouched because none of them know or care
 * which lane produced the text.
 *
 * NO LIMITS ARE RECORDED HERE. Every provider publishes its own, they change,
 * and a number written down in code is a number nobody re-reads. Read them from
 * the provider's console and put them in MODEL_CALLS_PER_MINUTE and
 * MODEL_CALLS_PER_DAY, the same discipline docs/quota.md applies to Gemini.
 */
interface Lane {
  baseURL: string;
  /** The environment variable holding this provider's key. */
  keyName: string;
  label: string;
}

const OPENAI_COMPATIBLE: Record<string, Lane> = {
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    keyName: 'GROQ_API_KEY',
    label: 'Groq',
  },
  deepseek: {
    baseURL: 'https://api.deepseek.com/v1',
    keyName: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek',
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    keyName: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
  },
  together: {
    baseURL: 'https://api.together.xyz/v1',
    keyName: 'TOGETHER_API_KEY',
    label: 'Together',
  },
  cerebras: {
    baseURL: 'https://api.cerebras.ai/v1',
    keyName: 'CEREBRAS_API_KEY',
    label: 'Cerebras',
  },
  mistral: {
    baseURL: 'https://api.mistral.ai/v1',
    keyName: 'MISTRAL_API_KEY',
    label: 'Mistral',
  },
};

const PROVIDERS: Record<string, (ref: ModelRef) => LanguageModel> = {
  google: (ref) => {
    const key = env().GOOGLE_GENERATIVE_AI_API_KEY;
    if (!key) throw new ModelUnavailable('google', 'GOOGLE_GENERATIVE_AI_API_KEY is not set');
    return createGoogleGenerativeAI({ apiKey: key, fetch: diagnosticFetch })(ref.modelId);
  },

  ...Object.fromEntries(
    Object.entries(OPENAI_COMPATIBLE).map(([name, lane]) => [
      name,
      (ref: ModelRef) => {
        const key = process.env[lane.keyName];
        if (!key) throw new ModelUnavailable(name, `${lane.keyName} is not set`);
        return createOpenAICompatible({
          name,
          baseURL: lane.baseURL,
          apiKey: key,
          fetch: diagnosticFetch,
        })(ref.modelId);
      },
    ]),
  ),
};

/** Providers this build can reach, for the settings page and for error text. */
export function knownProviders(): string[] {
  return Object.keys(PROVIDERS);
}

export class ModelUnavailable extends Error {
  readonly provider: string;
  constructor(provider: string, detail: string) {
    super(`${provider}: ${detail}`);
    this.name = 'ModelUnavailable';
    this.provider = provider;
  }
}

export interface ResolvedModel {
  model: LanguageModel;
  provider: string;
  modelId: string;
  /** True when the primary was unavailable and the second lane was used. */
  isFallback: boolean;
}

/**
 * Resolve the model, falling back if the primary cannot be BUILT — a missing
 * key, an unregistered provider. Failure to resolve is loud: there is no silent
 * degrade to a different capability tier, because a quietly worse model
 * produces quietly worse answers and nothing says so.
 */
export function resolveModel(): ResolvedModel {
  const lanes = resolveLanes();
  const first = lanes[0];
  if (!first) throw new ModelUnavailable('none', 'no model could be resolved');
  return first;
}

/**
 * Every lane that can be built, primary first.
 *
 * `MODEL_FALLBACK` used to be reached only when the primary could not be
 * constructed — a missing API key. That is the rarest way a model becomes
 * unavailable and the least interesting: the common one is the primary being
 * over its rate limit, which is a property of the call, not of the
 * configuration, and which the old code could not see. A caller walks this list
 * so that a lane refusing on quota moves to the next one instead of failing the
 * request.
 *
 * A fallback on the SAME provider is not a fallback. If Gemini is out of
 * requests for the day, a second Gemini model is out of requests too — the
 * limit is per project, not per model. Same-provider lanes are dropped here
 * rather than being discovered as a second identical refusal.
 */
export function resolveLanes(): ResolvedModel[] {
  const lanes: ResolvedModel[] = [];
  const primary = parseModelRef(env().MODEL_PRIMARY);

  let primaryError: unknown = null;
  try {
    lanes.push({ model: build(primary), ...primary, isFallback: false });
  } catch (error) {
    // Missing keys may use the existing backup lane; an unknown adapter is
    // a configuration error, not a transient provider failure.
    if (!PROVIDERS[primary.provider]) throw error;
    primaryError = error;
  }

  const configured = env().MODEL_FALLBACK;
  if (configured) {
    const fallback = parseModelRef(configured);
    const sameProvider = primary.provider === fallback.provider;
    if (!sameProvider) {
      try {
        lanes.push({ model: build(fallback), ...fallback, isFallback: true });
      } catch {
        // A fallback that cannot be built is not an error while the primary
        // works. It becomes one only if there is nothing left, below.
      }
    }
  }

  if (lanes.length === 0) throw primaryError ?? new ModelUnavailable('none', 'no lane available');
  return lanes;
}

function build(ref: ModelRef): LanguageModel {
  const factory = PROVIDERS[ref.provider];
  if (!factory) {
    throw new ModelUnavailable(
      ref.provider,
      `no adapter for this provider. Known: ${knownProviders().join(', ')}`,
    );
  }
  return factory(ref);
}

/**
 * Quota rationing.
 *
 * THE UNIT IS CALLS, NOT MESSAGES. One chat message becomes several model calls
 * once the tool loop runs — a request, a tool result, a follow-up, sometimes a
 * repair attempt. A cap expressed in messages per day is silently several times
 * looser than it reads, and the observed ratio has to be measured from real
 * turns rather than assumed.
 *
 * Scheduled card generation reserves its allowance first. Heavy chat use must
 * not be able to starve the dashboard, because the dashboard is the surface
 * that runs while nobody is watching.
 */
export interface QuotaCaps {
  /** Total provider CALLS per day across all purposes. */
  dailyCalls: number;
  /** Calls held back for scheduled generation, unavailable to chat. */
  reservedForCards: number;
  /**
   * Calls per MINUTE, across everything.
   *
   * This is the limit that actually fires on a free tier, and the daily cap
   * never sees it coming. The observed value for `gemini-3.6-flash` free tier
   * is five — small enough that one question with a three-step tool loop can
   * spend most of a minute's allowance by itself. Recorded in docs/quota.md
   * with the date it was observed.
   */
  callsPerMinute: number;
}

export interface QuotaLedger {
  /** Calls already spent today for a purpose. Failures count — a failed call
   *  spent the same quota as a successful one. */
  callsToday(purpose: Purpose): Promise<number>;
  /** Calls spent in the last 60 seconds, across every purpose. */
  callsLastMinute(): Promise<number>;
  /**
   * When the oldest call still inside the 24-hour window was made, or null if
   * there is none. The daily cap here is a ROLLING window, so this is when the
   * first slot frees — which is a true statement about this app's own guard,
   * unlike a guess at when the provider resets its counter.
   */
  oldestCallInWindow?(): Promise<Date | null>;
}

export interface Headroom {
  allowed: boolean;
  used: number;
  limit: number;
  reason?: string;
  /** Seconds until this is worth trying again. Only set for the per-minute limit. */
  retryAfterSeconds?: number;
}

/**
 * Roughly how many more questions the day's budget allows.
 *
 * Deliberately conservative — it divides by the worst case, the full step
 * ceiling, so the number never promises more than it can deliver. On a
 * twenty-a-day tier this is the single most useful thing to know before typing,
 * which is why it is on screen rather than discovered by being refused.
 */
export function questionsLeft(used: number, caps: QuotaCaps): number {
  const available = Math.max(0, caps.dailyCalls - caps.reservedForCards - used);
  return Math.floor(available / maxStepsFor(caps));
}

/**
 * How many steps one message may take.
 *
 * A tool loop is not one request — every step is another one. So the ceiling on
 * steps has to sit under the per-minute limit, or a single `generateText` blows
 * the budget from the inside where no pre-flight check can see it. One call is
 * held back so that asking a second question does not have to wait a full
 * minute, and the whole thing is capped at 8 because past that a loop is stuck
 * rather than working.
 */
export function maxStepsFor(caps: QuotaCaps): number {
  return Math.max(2, Math.min(8, caps.callsPerMinute - 1));
}

export async function checkHeadroom(
  purpose: Purpose,
  ledger: QuotaLedger,
  caps: QuotaCaps,
): Promise<Headroom> {
  const [chat, cards, lastMinute] = await Promise.all([
    ledger.callsToday('chat'),
    ledger.callsToday('cards'),
    ledger.callsLastMinute(),
  ]);

  // The per-minute limit is checked first because it is the one that fires, and
  // because it clears on its own — telling someone to wait forty seconds is a
  // different message from telling them they are done for the day.
  const steps = maxStepsFor(caps);
  if (lastMinute + steps > caps.callsPerMinute) {
    return {
      allowed: false,
      used: lastMinute,
      limit: caps.callsPerMinute,
      reason: `That would go over ${caps.callsPerMinute} requests a minute, which is what this plan allows.`,
      retryAfterSeconds: 60,
    };
  }

  const used = purpose === 'chat' ? chat : cards;

  if (purpose === 'cards') {
    const limit = caps.dailyCalls;
    return used < limit
      ? { allowed: true, used, limit }
      : { allowed: false, used, limit, reason: "today's model allowance is spent" };
  }

  // Chat may use everything except what is held back for the scheduled run.
  const limit = Math.max(0, caps.dailyCalls - caps.reservedForCards);
  const spentOnCards = Math.min(cards, caps.reservedForCards);
  const availableToChat = limit - Math.max(0, cards - spentOnCards);

  if (used < availableToChat) return { allowed: true, used, limit: availableToChat };

  // The daily cap is a rolling 24-hour window, so it frees gradually rather
  // than all at once. Saying when the first slot comes back beats "come back
  // tomorrow", which would be wrong by up to a day in either direction.
  const oldest = await ledger.oldestCallInWindow?.();
  const freesIn = oldest
    ? Math.max(60, Math.ceil((oldest.getTime() + 86_400_000 - Date.now()) / 1000))
    : undefined;

  return {
    allowed: false,
    used,
    limit: availableToChat,
    reason: `Today's ${caps.dailyCalls} requests are spent, and the rest is held for the dashboard notes.`,
    retryAfterSeconds: freesIn,
  };
}

/** Caps as configured. Read from the environment so the plan can change without a deploy. */
export function quotaCaps(provider?: string): QuotaCaps {
  const config = env();
  const dailyCalls =
    provider === 'groq'
      ? (config.GROQ_CALLS_PER_DAY ?? config.MODEL_CALLS_PER_DAY)
      : config.MODEL_CALLS_PER_DAY;
  return {
    dailyCalls,
    reservedForCards: Math.min(40, Math.floor(dailyCalls / 5)),
    callsPerMinute:
      provider === 'groq'
        ? (config.GROQ_CALLS_PER_MINUTE ?? config.MODEL_CALLS_PER_MINUTE)
        : config.MODEL_CALLS_PER_MINUTE,
  };
}

export type ProviderFailure =
  'quota' | 'transient' | 'auth' | 'invalid_request' | 'provider' | 'application';

/** Only SDK transport errors qualify for failover; tool/DB exceptions do not. */
export function classifyProviderFailure(error: unknown): ProviderFailure {
  if (!APICallError.isInstance(error)) return 'application';
  const status = error.statusCode;
  if (status === 429) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request';
  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status === undefined && error.isRetryable)
  )
    return 'transient';
  return 'provider';
}

/**
 * A provider saying "you are over your quota", told apart from a provider being
 * broken.
 *
 * These are not the same event and must not produce the same response. A quota
 * error clears by waiting; a 500 does not. Retrying a quota error is actively
 * harmful — the SDK's default of three attempts spent three of the five
 * requests a minute allows on a call that could not have succeeded.
 */
export interface QuotaError {
  isQuota: true;
  retryAfterSeconds: number;
  message: string;
}

export function asQuotaError(error: unknown): QuotaError | null {
  const status =
    (error as { statusCode?: number; status?: number } | null)?.statusCode ??
    (error as { status?: number } | null)?.status;
  const message = error instanceof Error ? error.message : String(error);

  const looksLikeQuota =
    status === 429 ||
    (status === undefined && /quota|rate.?limit|resource[_ ]exhausted/i.test(message));
  if (!looksLikeQuota) return null;

  // Providers state the wait in the error itself. Honouring it beats guessing,
  // and guessing low is how a retry storm starts.
  const stated =
    /retry in ([\d.]+)\s*s/i.exec(message)?.[1] ?? /retryDelay"?:\s*"?(\d+)s/i.exec(message)?.[1];

  return {
    isQuota: true,
    retryAfterSeconds: retryAfter(error, stated),
    message,
  };
}

function retryAfter(error: unknown, stated?: string): number {
  const header = APICallError.isInstance(error)
    ? error.responseHeaders?.['retry-after']
    : undefined;
  const seconds = header
    ? /^\d+(?:\.\d+)?$/.test(header)
      ? Number(header)
      : (Date.parse(header) - Date.now()) / 1000
    : stated
      ? Number(stated)
      : 60;
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 60;
}
