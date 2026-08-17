import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Single-user, single-account schema. There are deliberately no `user_id`
 * columns, no tenancy, and no soft-delete bookkeeping — this app is a
 * personal dashboard for one Instagram account, not a SaaS product.
 *
 * Runs on Supabase Postgres. Timestamps are `timestamptz`; ids are serial.
 */

const now = sql`now()`;

// --- settings ---------------------------------------------------------------

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
});

// --- accounts (self + discovered competitors) --------------------------------

export const accounts = pgTable(
  'accounts',
  {
    id: serial('id').primaryKey(),
    handle: text('handle').notNull(),
    role: text('role', { enum: ['self', 'competitor'] }).notNull(),
    igUserId: text('ig_user_id'),
    fullName: text('full_name'),
    bio: text('bio'),
    followers: integer('followers'),
    following: integer('following'),
    postsCount: integer('posts_count'),
    isVerified: boolean('is_verified').notNull().default(false),
    /** Inferred niche label — set on the self account by the single niche-inference call. */
    niche: text('niche'),
    /** Which of the self account's hashtags this competitor was discovered through. */
    discoveredViaHashtag: text('discovered_via_hashtag'),
    active: boolean('active').notNull().default(true),
    lastScrapedAt: timestamp('last_scraped_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [uniqueIndex('accounts_handle_uq').on(t.handle), index('accounts_role_idx').on(t.role)],
);

// --- posts (own + competitors) ------------------------------------------------

export const posts = pgTable(
  'posts',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    shortcode: text('shortcode').notNull(),
    type: text('type', { enum: ['image', 'carousel', 'reel', 'video', 'unknown'] })
      .notNull()
      .default('unknown'),
    caption: text('caption'),
    takenAt: timestamp('taken_at', { withTimezone: true }),
    likes: integer('likes'),
    comments: integer('comments'),
    views: integer('views'),
    plays: integer('plays'),
    durationS: real('duration_s'),
    carouselCount: integer('carousel_count'),
    thumbnailUrl: text('thumbnail_url'),
    mediaUrls: jsonb('media_urls').$type<string[]>(),
    isSponsored: boolean('is_sponsored').notNull().default(false),
    /**
     * The untouched Apify actor payload. Mandatory: actor schemas drift, and
     * keeping the raw response means re-normalisation never costs another scrape.
     */
    raw: jsonb('raw').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().default(now),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    uniqueIndex('posts_shortcode_uq').on(t.shortcode),
    index('posts_account_taken_idx').on(t.accountId, t.takenAt),
    index('posts_type_idx').on(t.type),
  ],
);

// --- post_features (deterministic, Layer A) -----------------------------------

export const postFeatures = pgTable(
  'post_features',
  {
    postId: integer('post_id')
      .primaryKey()
      .references(() => posts.id, { onDelete: 'cascade' }),
    captionLength: integer('caption_length').notNull().default(0),
    firstLine: text('first_line'),
    hookText: text('hook_text'),
    hashtagCount: integer('hashtag_count').notNull().default(0),
    mentionCount: integer('mention_count').notNull().default(0),
    emojiCount: integer('emoji_count').notNull().default(0),
    hasQuestion: boolean('has_question').notNull().default(false),
    hasCta: boolean('has_cta').notNull().default(false),
    postedHour: integer('posted_hour'),
    postedDow: integer('posted_dow'),
    engagementRate: doublePrecision('engagement_rate'),
    likesZ: doublePrecision('likes_z'),
    viewsZ: doublePrecision('views_z'),
    isOutlier: boolean('is_outlier').notNull().default(false),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [index('post_features_outlier_idx').on(t.isOutlier)],
);

// --- hook_labels (per-post Gemini classification — replaces embed+cluster) ---

/**
 * Growy-style hook labeling: one Gemini call per post classifies its opening
 * line into a named category (e.g. "question hook", "bold claim", "listicle
 * open"). This is what makes "51% of top reels use X hook, you use it 20%"
 * possible. Deliberately flat — no embedding/clustering step, since v1 tracks
 * Growy's presumed per-post-classification approach rather than improving on it.
 */
export const hookLabels = pgTable(
  'hook_labels',
  {
    postId: integer('post_id')
      .primaryKey()
      .references(() => posts.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    confidence: real('confidence'),
    generatedBy: text('generated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [index('hook_labels_category_idx').on(t.category)],
);

// --- analyses (5 patterns + 1 gap, each tagged with source post ids) ---------

export const analyses = pgTable(
  'analyses',
  {
    id: serial('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    windowDays: integer('window_days').notNull(),
    /** Pattern[] — each { name, description, nicheStat, myStat, delta, postIds[] }. */
    patterns: jsonb('patterns').notNull(),
    /** { claim, nicheStat, myStat, delta, postIds[] } — the single biggest gap. */
    gap: jsonb('gap').notNull(),
    inputsHash: text('inputs_hash').notNull(),
    generatedBy: text('generated_by').notNull(),
  },
  (t) => [index('analyses_hash_idx').on(t.inputsHash)],
);

// --- resurfaced_posts (back-catalogue mining, deterministic) -----------------

/**
 * "Your DM-funnel reel hit 552K, you haven't made one like it in 30 days" —
 * past high performers whose hook category / archetype hasn't been repeated
 * recently. Each row's `postId` is its own receipt.
 */
export const resurfacedPosts = pgTable(
  'resurfaced_posts',
  {
    id: serial('id').primaryKey(),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    metric: text('metric').notNull(),
    peakValue: doublePrecision('peak_value').notNull(),
    daysSinceRepeated: integer('days_since_repeated').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [index('resurfaced_posts_post_idx').on(t.postId)],
);

// --- voice_profile -------------------------------------------------------------

export const voiceProfile = pgTable(
  'voice_profile',
  {
    id: serial('id').primaryKey(),
    version: integer('version').notNull(),
    markdown: text('markdown').notNull(),
    fields: jsonb('fields').notNull(),
    active: boolean('active').notNull().default(true),
    generatedBy: text('generated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [uniqueIndex('voice_profile_version_uq').on(t.version)],
);

// --- drafts ----------------------------------------------------------------

export const drafts = pgTable(
  'drafts',
  {
    id: serial('id').primaryKey(),
    analysisId: integer('analysis_id').references(() => analyses.id, { onDelete: 'set null' }),
    format: text('format', { enum: ['carousel', 'reel', 'image'] }).notNull(),
    patternIndex: integer('pattern_index'),
    title: text('title').notNull(),
    hook: text('hook').notNull(),
    /** Carousel body: { headline, slides: [{text}], cta }. */
    body: jsonb('body').notNull(),
    caption: text('caption').notNull(),
    hashtags: jsonb('hashtags').$type<string[]>().notNull(),
    cta: text('cta'),
    rationale: text('rationale'),
    evidence: jsonb('evidence').$type<number[]>(),
    status: text('status', { enum: ['draft', 'approved', 'scheduled', 'published', 'discarded'] })
      .notNull()
      .default('draft'),
    generatedBy: text('generated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [index('drafts_status_idx').on(t.status), index('drafts_analysis_idx').on(t.analysisId)],
);

// --- draft_assets (slide PNGs, stored in Supabase Storage) -------------------

export const draftAssets = pgTable(
  'draft_assets',
  {
    id: serial('id').primaryKey(),
    draftId: integer('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['slide', 'background', 'cover'] }).notNull(),
    slideIndex: integer('slide_index'),
    /** Path inside the Supabase Storage bucket. */
    storagePath: text('storage_path'),
    publicUrl: text('public_url'),
    prompt: text('prompt'),
    provider: text('provider'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [index('draft_assets_draft_idx').on(t.draftId)],
);

// --- schedule (Graph API publish queue) ---------------------------------------

export const schedule = pgTable(
  'schedule',
  {
    id: serial('id').primaryKey(),
    draftId: integer('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    status: text('status', {
      enum: ['pending', 'claimed', 'publishing', 'published', 'failed'],
    })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    igMediaId: text('ig_media_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [index('schedule_due_idx').on(t.status, t.scheduledFor)],
);

// --- chat --------------------------------------------------------------------

export const chatThreads = pgTable('chat_threads', {
  id: serial('id').primaryKey(),
  title: text('title').notNull().default('New thread'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
});

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: serial('id').primaryKey(),
    threadId: integer('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['system', 'user', 'assistant', 'tool'] }).notNull(),
    content: text('content').notNull(),
    toolCalls: jsonb('tool_calls'),
    generatedBy: text('generated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [index('chat_messages_thread_idx').on(t.threadId, t.id)],
);

// --- runs (every LLM/scrape call, for the $0.00 cost check) ------------------

export const runs = pgTable(
  'runs',
  {
    id: serial('id').primaryKey(),
    provider: text('provider').notNull(),
    model: text('model'),
    operation: text('operation').notNull(),
    costEstimate: real('cost_estimate').notNull().default(0),
    freeTier: boolean('free_tier').notNull().default(true),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    durationMs: integer('duration_ms'),
    status: text('status', { enum: ['ok', 'error', 'quota', 'skipped'] }).notNull(),
    error: text('error'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [index('runs_created_idx').on(t.createdAt), index('runs_provider_idx').on(t.provider)],
);

// --- quota_budget (Gemini free-tier rationing, per job type) -----------------

export const quotaBudget = pgTable(
  'quota_budget',
  {
    id: serial('id').primaryKey(),
    provider: text('provider').notNull(),
    jobType: text('job_type').notNull(),
    dailyAllowance: integer('daily_allowance').notNull(),
    consumedToday: integer('consumed_today').notNull().default(0),
    resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
    /** Observed from rate-limit headers / 429s. Never hardcoded. */
    observedLimit: integer('observed_limit'),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    exhaustedUntil: timestamp('exhausted_until', { withTimezone: true }),
  },
  (t) => [uniqueIndex('quota_provider_job_uq').on(t.provider, t.jobType)],
);

// --- jobs (resumable jobs table — the backbone of every long op on Vercel) ---

/**
 * Vercel Hobby functions have a hard duration ceiling. Nothing here blocks on
 * a multi-minute operation: a scan fires the Apify actor and returns; a
 * webhook (or a cron poll) advances the job by one step and returns again.
 * `checkpoint` is what makes a step resumable rather than a restart.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: serial('id').primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status', {
      enum: ['pending', 'claimed', 'running', 'waiting', 'done', 'failed', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    priority: integer('priority').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** Progress + resume point, written by each step before it returns. */
    checkpoint: jsonb('checkpoint'),
    progress: real('progress').notNull().default(0),
    progressLabel: text('progress_label'),
    lastError: text('last_error'),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().default(now),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index('jobs_claim_idx').on(t.status, t.priority, t.runAfter),
    index('jobs_type_idx').on(t.type, t.status),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type QuotaBudget = typeof quotaBudget.$inferSelect;
