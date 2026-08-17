CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`handle` text NOT NULL,
	`role` text NOT NULL,
	`ig_user_id` text,
	`full_name` text,
	`bio` text,
	`followers` integer,
	`following` integer,
	`posts_count` integer,
	`is_verified` integer DEFAULT false NOT NULL,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`last_scraped_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_handle_uq` ON `accounts` (`handle`);--> statement-breakpoint
CREATE INDEX `accounts_role_idx` ON `accounts` (`role`);--> statement-breakpoint
CREATE TABLE `analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`window_days` integer NOT NULL,
	`patterns` text NOT NULL,
	`gap` text NOT NULL,
	`inputs_hash` text NOT NULL,
	`generated_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `analyses_hash_idx` ON `analyses` (`inputs_hash`);--> statement-breakpoint
CREATE TABLE `archetypes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cluster_id` integer NOT NULL,
	`run_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`centroid` blob NOT NULL,
	`dim` integer NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`user_renamed` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`generated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `archetypes_run_cluster_uq` ON `archetypes` (`run_id`,`cluster_id`);--> statement-breakpoint
CREATE INDEX `archetypes_active_idx` ON `archetypes` (`active`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_calls` text,
	`generated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_messages_thread_idx` ON `chat_messages` (`thread_id`,`id`);--> statement-breakpoint
CREATE TABLE `chat_threads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text DEFAULT 'New thread' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `draft_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`draft_id` integer NOT NULL,
	`kind` text NOT NULL,
	`slide_index` integer,
	`local_path` text,
	`public_url` text,
	`prompt` text,
	`provider` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `draft_assets_draft_idx` ON `draft_assets` (`draft_id`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`analysis_id` integer,
	`format` text NOT NULL,
	`pattern_index` integer,
	`title` text NOT NULL,
	`hook` text NOT NULL,
	`body` text NOT NULL,
	`caption` text NOT NULL,
	`hashtags` text NOT NULL,
	`cta` text,
	`rationale` text,
	`evidence` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`generated_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `drafts_status_idx` ON `drafts` (`status`);--> statement-breakpoint
CREATE INDEX `drafts_analysis_idx` ON `drafts` (`analysis_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`checkpoint` text,
	`progress` real DEFAULT 0 NOT NULL,
	`progress_label` text,
	`last_error` text,
	`run_after` integer DEFAULT (unixepoch()) NOT NULL,
	`claimed_at` integer,
	`heartbeat_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`priority`,`run_after`);--> statement-breakpoint
CREATE INDEX `jobs_type_idx` ON `jobs` (`type`,`status`);--> statement-breakpoint
CREATE TABLE `post_embeddings` (
	`post_id` integer PRIMARY KEY NOT NULL,
	`vector` blob NOT NULL,
	`dim` integer NOT NULL,
	`model` text NOT NULL,
	`source_text` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_embeddings_model_idx` ON `post_embeddings` (`model`);--> statement-breakpoint
CREATE TABLE `post_features` (
	`post_id` integer PRIMARY KEY NOT NULL,
	`caption_length` integer DEFAULT 0 NOT NULL,
	`first_line` text,
	`hook_text` text,
	`spoken_hook` text,
	`hashtag_count` integer DEFAULT 0 NOT NULL,
	`mention_count` integer DEFAULT 0 NOT NULL,
	`emoji_count` integer DEFAULT 0 NOT NULL,
	`has_question` integer DEFAULT false NOT NULL,
	`has_cta` integer DEFAULT false NOT NULL,
	`posted_hour` integer,
	`posted_dow` integer,
	`engagement_rate` real,
	`likes_z` real,
	`views_z` real,
	`is_outlier` integer DEFAULT false NOT NULL,
	`computed_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_features_outlier_idx` ON `post_features` (`is_outlier`);--> statement-breakpoint
CREATE TABLE `post_labels` (
	`post_id` integer PRIMARY KEY NOT NULL,
	`archetype_id` integer NOT NULL,
	`distance` real NOT NULL,
	`assigned_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`archetype_id`) REFERENCES `archetypes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_labels_archetype_idx` ON `post_labels` (`archetype_id`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`shortcode` text NOT NULL,
	`type` text DEFAULT 'unknown' NOT NULL,
	`caption` text,
	`taken_at` integer,
	`likes` integer,
	`comments` integer,
	`views` integer,
	`plays` integer,
	`duration_s` real,
	`carousel_count` integer,
	`thumbnail_url` text,
	`media_urls` text,
	`is_sponsored` integer DEFAULT false NOT NULL,
	`raw` text NOT NULL,
	`first_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `posts_shortcode_uq` ON `posts` (`shortcode`);--> statement-breakpoint
CREATE INDEX `posts_account_taken_idx` ON `posts` (`account_id`,`taken_at`);--> statement-breakpoint
CREATE INDEX `posts_type_idx` ON `posts` (`type`);--> statement-breakpoint
CREATE TABLE `quota_budget` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`job_type` text NOT NULL,
	`daily_allowance` integer NOT NULL,
	`consumed_today` integer DEFAULT 0 NOT NULL,
	`reset_at` integer NOT NULL,
	`observed_limit` integer,
	`observed_at` integer,
	`exhausted_until` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quota_provider_job_uq` ON `quota_budget` (`provider`,`job_type`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`operation` text NOT NULL,
	`tier` text DEFAULT 'none' NOT NULL,
	`cost_estimate` real DEFAULT 0 NOT NULL,
	`free_tier` integer DEFAULT true NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`duration_ms` integer,
	`status` text NOT NULL,
	`error` text,
	`meta` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runs_created_idx` ON `runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `runs_provider_idx` ON `runs` (`provider`);--> statement-breakpoint
CREATE TABLE `schedule` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`draft_id` integer NOT NULL,
	`scheduled_for` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`mode` text DEFAULT 'manual' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`ig_media_id` text,
	`notified_at` integer,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schedule_due_idx` ON `schedule` (`status`,`scheduled_for`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `voice_profile` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version` integer NOT NULL,
	`markdown` text NOT NULL,
	`fields` text NOT NULL,
	`edited_by_user` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`generated_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voice_profile_version_uq` ON `voice_profile` (`version`);