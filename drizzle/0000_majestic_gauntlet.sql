CREATE TABLE "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"role" text NOT NULL,
	"ig_user_id" text,
	"full_name" text,
	"bio" text,
	"followers" integer,
	"following" integer,
	"posts_count" integer,
	"is_verified" boolean DEFAULT false NOT NULL,
	"niche" text,
	"discovered_via_hashtag" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_scraped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"window_days" integer NOT NULL,
	"patterns" jsonb NOT NULL,
	"gap" jsonb NOT NULL,
	"inputs_hash" text NOT NULL,
	"generated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb,
	"generated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text DEFAULT 'New thread' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"draft_id" integer NOT NULL,
	"kind" text NOT NULL,
	"slide_index" integer,
	"storage_path" text,
	"public_url" text,
	"prompt" text,
	"provider" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"analysis_id" integer,
	"format" text NOT NULL,
	"pattern_index" integer,
	"title" text NOT NULL,
	"hook" text NOT NULL,
	"body" jsonb NOT NULL,
	"caption" text NOT NULL,
	"hashtags" jsonb NOT NULL,
	"cta" text,
	"rationale" text,
	"evidence" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"generated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hook_labels" (
	"post_id" integer PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"confidence" real,
	"generated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"checkpoint" jsonb,
	"progress" real DEFAULT 0 NOT NULL,
	"progress_label" text,
	"last_error" text,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_features" (
	"post_id" integer PRIMARY KEY NOT NULL,
	"caption_length" integer DEFAULT 0 NOT NULL,
	"first_line" text,
	"hook_text" text,
	"hashtag_count" integer DEFAULT 0 NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"emoji_count" integer DEFAULT 0 NOT NULL,
	"has_question" boolean DEFAULT false NOT NULL,
	"has_cta" boolean DEFAULT false NOT NULL,
	"posted_hour" integer,
	"posted_dow" integer,
	"engagement_rate" double precision,
	"likes_z" double precision,
	"views_z" double precision,
	"is_outlier" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"shortcode" text NOT NULL,
	"type" text DEFAULT 'unknown' NOT NULL,
	"caption" text,
	"taken_at" timestamp with time zone,
	"likes" integer,
	"comments" integer,
	"views" integer,
	"plays" integer,
	"duration_s" real,
	"carousel_count" integer,
	"thumbnail_url" text,
	"media_urls" jsonb,
	"is_sponsored" boolean DEFAULT false NOT NULL,
	"raw" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_budget" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"job_type" text NOT NULL,
	"daily_allowance" integer NOT NULL,
	"consumed_today" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"observed_limit" integer,
	"observed_at" timestamp with time zone,
	"exhausted_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "resurfaced_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"metric" text NOT NULL,
	"peak_value" double precision NOT NULL,
	"days_since_repeated" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"operation" text NOT NULL,
	"cost_estimate" real DEFAULT 0 NOT NULL,
	"free_tier" boolean DEFAULT true NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"duration_ms" integer,
	"status" text NOT NULL,
	"error" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule" (
	"id" serial PRIMARY KEY NOT NULL,
	"draft_id" integer NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"ig_media_id" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_profile" (
	"id" serial PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"markdown" text NOT NULL,
	"fields" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"generated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_assets" ADD CONSTRAINT "draft_assets_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hook_labels" ADD CONSTRAINT "hook_labels_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_features" ADD CONSTRAINT "post_features_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resurfaced_posts" ADD CONSTRAINT "resurfaced_posts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_handle_uq" ON "accounts" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "accounts_role_idx" ON "accounts" USING btree ("role");--> statement-breakpoint
CREATE INDEX "analyses_hash_idx" ON "analyses" USING btree ("inputs_hash");--> statement-breakpoint
CREATE INDEX "chat_messages_thread_idx" ON "chat_messages" USING btree ("thread_id","id");--> statement-breakpoint
CREATE INDEX "draft_assets_draft_idx" ON "draft_assets" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "drafts_status_idx" ON "drafts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "drafts_analysis_idx" ON "drafts" USING btree ("analysis_id");--> statement-breakpoint
CREATE INDEX "hook_labels_category_idx" ON "hook_labels" USING btree ("category");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","priority","run_after");--> statement-breakpoint
CREATE INDEX "jobs_type_idx" ON "jobs" USING btree ("type","status");--> statement-breakpoint
CREATE INDEX "post_features_outlier_idx" ON "post_features" USING btree ("is_outlier");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_shortcode_uq" ON "posts" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "posts_account_taken_idx" ON "posts" USING btree ("account_id","taken_at");--> statement-breakpoint
CREATE INDEX "posts_type_idx" ON "posts" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_provider_job_uq" ON "quota_budget" USING btree ("provider","job_type");--> statement-breakpoint
CREATE INDEX "resurfaced_posts_post_idx" ON "resurfaced_posts" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "runs_created_idx" ON "runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "runs_provider_idx" ON "runs" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "schedule_due_idx" ON "schedule" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_profile_version_uq" ON "voice_profile" USING btree ("version");