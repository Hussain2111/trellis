import { sql } from 'drizzle-orm';
import {
  blob,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Single-user, single-account schema. There are deliberately no `user_id`
 * columns, no tenancy, and no soft-delete bookkeeping — see §2 of the spec.
 *
 * Timestamps are stored as unix epoch seconds (integer) so SQLite can compare
 * and index them without date parsing.
 */

const now = sql`(unixepoch())`;

// --- settings ---------------------------------------------------------------

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON-encoded
  updatedAt: integer('updated_at').notNull().default(now),
});

// --- accounts ---------------------------------------------------------------

export const accounts = sqliteTable(
  'accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    handle: text('handle').notNull(),
    role: text('role', { enum: ['self', 'competitor'] }).notNull(),
    igUserId: text('ig_user_id'),
    fullName: text('full_name'),
    bio: text('bio'),
    followers: integer('followers'),
    following: integer('following'),
    postsCount: integer('posts_count'),
    isVerified: integer('is_verified', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    lastScrapedAt: integer('last_scraped_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('accounts_handle_uq').on(t.handle), index('accounts_role_idx').on(t.role)],
);

// --- posts ------------------------------------------------------------------

export const posts = sqliteTable(
  'posts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    shortcode: text('shortcode').notNull(),
    type: text('type', { enum: ['image', 'carousel', 'reel', 'video', 'unknown'] })
      .notNull()
      .default('unknown'),
    caption: text('caption'),
    takenAt: integer('taken_at'),
    likes: integer('likes'),
    comments: integer('comments'),
    views: integer('views'),
    plays: integer('plays'),
    durationS: real('duration_s'),
    carouselCount: integer('carousel_count'),
    thumbnailUrl: text('thumbnail_url'),
    mediaUrls: text('media_urls', { mode: 'json' }).$type<string[]>(),
    isSponsored: integer('is_sponsored', { mode: 'boolean' }).notNull().default(false),
    /**
     * The untouched actor payload. Mandatory: actor schemas drift, and keeping
     * the raw response means re-normalisation never costs another scrape.
     */
    raw: text('raw', { mode: 'json' }).notNull(),
    firstSeenAt: integer('first_seen_at').notNull().default(now),
    lastSeenAt: integer('last_seen_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('posts_shortcode_uq').on(t.shortcode),
    index('posts_account_taken_idx').on(t.accountId, t.takenAt),
    index('posts_type_idx').on(t.type),
  ],
);

// --- post_features ----------------------------------------------------------

export const postFeatures = sqliteTable(
  'post_features',
  {
    postId: integer('post_id')
      .primaryKey()
      .references(() => posts.id, { onDelete: 'cascade' }),
    captionLength: integer('caption_length').notNull().default(0),
    firstLine: text('first_line'),
    hookText: text('hook_text'),
    spokenHook: text('spoken_hook'),
    hashtagCount: integer('hashtag_count').notNull().default(0),
    mentionCount: integer('mention_count').notNull().default(0),
    emojiCount: integer('emoji_count').notNull().default(0),
    hasQuestion: integer('has_question', { mode: 'boolean' }).notNull().default(false),
    hasCta: integer('has_cta', { mode: 'boolean' }).notNull().default(false),
    postedHour: integer('posted_hour'),
    postedDow: integer('posted_dow'),
    engagementRate: real('engagement_rate'),
    likesZ: real('likes_z'),
    viewsZ: real('views_z'),
    isOutlier: integer('is_outlier', { mode: 'boolean' }).notNull().default(false),
    computedAt: integer('computed_at').notNull().default(now),
  },
  (t) => [index('post_features_outlier_idx').on(t.isOutlier)],
);

// --- post_embeddings --------------------------------------------------------

export const postEmbeddings = sqliteTable(
  'post_embeddings',
  {
    postId: integer('post_id')
      .primaryKey()
      .references(() => posts.id, { onDelete: 'cascade' }),
    // Float32Array serialised as a blob. 1,100 x 768 floats is a few MB —
    // no vector database required.
    vector: blob('vector').notNull(),
    dim: integer('dim').notNull(),
    model: text('model').notNull(),
    sourceText: text('source_text'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('post_embeddings_model_idx').on(t.model)],
);

// --- archetypes -------------------------------------------------------------

export const archetypes = sqliteTable(
  'archetypes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clusterId: integer('cluster_id').notNull(),
    runId: text('run_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    centroid: blob('centroid').notNull(),
    dim: integer('dim').notNull(),
    size: integer('size').notNull().default(0),
    userRenamed: integer('user_renamed', { mode: 'boolean' }).notNull().default(false),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    generatedBy: text('generated_by'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('archetypes_run_cluster_uq').on(t.runId, t.clusterId),
    index('archetypes_active_idx').on(t.active),
  ],
);

// --- post_labels ------------------------------------------------------------

export const postLabels = sqliteTable(
  'post_labels',
  {
    postId: integer('post_id')
      .primaryKey()
      .references(() => posts.id, { onDelete: 'cascade' }),
    archetypeId: integer('archetype_id')
      .notNull()
      .references(() => archetypes.id, { onDelete: 'cascade' }),
    distance: real('distance').notNull(),
    assignedAt: integer('assigned_at').notNull().default(now),
  },
  (t) => [index('post_labels_archetype_idx').on(t.archetypeId)],
);

// --- analyses ---------------------------------------------------------------

export const analyses = sqliteTable(
  'analyses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    createdAt: integer('created_at').notNull().default(now),
    windowDays: integer('window_days').notNull(),
    patterns: text('patterns', { mode: 'json' }).notNull(),
    gap: text('gap', { mode: 'json' }).notNull(),
    inputsHash: text('inputs_hash').notNull(),
    generatedBy: text('generated_by').notNull(),
  },
  (t) => [index('analyses_hash_idx').on(t.inputsHash)],
);

// --- voice_profile ----------------------------------------------------------

export const voiceProfile = sqliteTable(
  'voice_profile',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    version: integer('version').notNull(),
    markdown: text('markdown').notNull(),
    fields: text('fields', { mode: 'json' }).notNull(),
    editedByUser: integer('edited_by_user', { mode: 'boolean' }).notNull().default(false),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    generatedBy: text('generated_by').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('voice_profile_version_uq').on(t.version)],
);

// --- drafts -----------------------------------------------------------------

export const drafts = sqliteTable(
  'drafts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    analysisId: integer('analysis_id').references(() => analyses.id, { onDelete: 'set null' }),
    format: text('format', { enum: ['carousel', 'reel', 'image'] }).notNull(),
    patternIndex: integer('pattern_index'),
    title: text('title').notNull(),
    hook: text('hook').notNull(),
    body: text('body', { mode: 'json' }).notNull(),
    caption: text('caption').notNull(),
    hashtags: text('hashtags', { mode: 'json' }).$type<string[]>().notNull(),
    cta: text('cta'),
    rationale: text('rationale'),
    evidence: text('evidence', { mode: 'json' }).$type<number[]>(),
    status: text('status', { enum: ['draft', 'approved', 'scheduled', 'published', 'discarded'] })
      .notNull()
      .default('draft'),
    generatedBy: text('generated_by').notNull(),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('drafts_status_idx').on(t.status), index('drafts_analysis_idx').on(t.analysisId)],
);

// --- draft_assets -----------------------------------------------------------

export const draftAssets = sqliteTable(
  'draft_assets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    draftId: integer('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['slide', 'background', 'cover', 'video'] }).notNull(),
    slideIndex: integer('slide_index'),
    localPath: text('local_path'),
    publicUrl: text('public_url'),
    prompt: text('prompt'),
    provider: text('provider'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('draft_assets_draft_idx').on(t.draftId)],
);

// --- schedule ---------------------------------------------------------------

export const schedule = sqliteTable(
  'schedule',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    draftId: integer('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    scheduledFor: integer('scheduled_for').notNull(),
    status: text('status', {
      enum: ['pending', 'claimed', 'publishing', 'published', 'failed'],
    })
      .notNull()
      .default('pending'),
    mode: text('mode', { enum: ['manual', 'api'] }).notNull().default('manual'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    igMediaId: text('ig_media_id'),
    notifiedAt: integer('notified_at'),
    publishedAt: integer('published_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('schedule_due_idx').on(t.status, t.scheduledFor)],
);

// --- chat -------------------------------------------------------------------

export const chatThreads = sqliteTable('chat_threads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull().default('New thread'),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
});

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    threadId: integer('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['system', 'user', 'assistant', 'tool'] }).notNull(),
    content: text('content').notNull(),
    toolCalls: text('tool_calls', { mode: 'json' }),
    generatedBy: text('generated_by'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('chat_messages_thread_idx').on(t.threadId, t.id)],
);

// --- runs -------------------------------------------------------------------

export const runs = sqliteTable(
  'runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    provider: text('provider').notNull(),
    model: text('model'),
    operation: text('operation').notNull(),
    tier: text('tier', { enum: ['A', 'B', 'none'] }).notNull().default('none'),
    costEstimate: real('cost_estimate').notNull().default(0),
    freeTier: integer('free_tier', { mode: 'boolean' }).notNull().default(true),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    durationMs: integer('duration_ms'),
    status: text('status', { enum: ['ok', 'error', 'quota', 'skipped'] }).notNull(),
    error: text('error'),
    meta: text('meta', { mode: 'json' }),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('runs_created_idx').on(t.createdAt), index('runs_provider_idx').on(t.provider)],
);

// --- quota_budget -----------------------------------------------------------

export const quotaBudget = sqliteTable(
  'quota_budget',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    provider: text('provider').notNull(),
    jobType: text('job_type').notNull(),
    dailyAllowance: integer('daily_allowance').notNull(),
    consumedToday: integer('consumed_today').notNull().default(0),
    resetAt: integer('reset_at').notNull(),
    /** Observed from rate-limit headers / 429s. Never hardcoded. */
    observedLimit: integer('observed_limit'),
    observedAt: integer('observed_at'),
    exhaustedUntil: integer('exhausted_until'),
  },
  (t) => [uniqueIndex('quota_provider_job_uq').on(t.provider, t.jobType)],
);

// --- jobs -------------------------------------------------------------------

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    status: text('status', {
      enum: ['pending', 'claimed', 'running', 'done', 'failed', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    priority: integer('priority').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** Progress + resume point. Long jobs on this laptop *will* be interrupted. */
    checkpoint: text('checkpoint', { mode: 'json' }),
    progress: real('progress').notNull().default(0),
    progressLabel: text('progress_label'),
    lastError: text('last_error'),
    runAfter: integer('run_after').notNull().default(now),
    claimedAt: integer('claimed_at'),
    heartbeatAt: integer('heartbeat_at'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    createdAt: integer('created_at').notNull().default(now),
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
export type Run = typeof runs.$inferSelect;
export type QuotaBudget = typeof quotaBudget.$inferSelect;
