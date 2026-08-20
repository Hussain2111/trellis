CREATE TABLE "follower_daily" (
	"day" text PRIMARY KEY NOT NULL,
	"follower_count" integer,
	"follows" integer,
	"unfollows" integer,
	"unavailable_reason" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follower_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"usernames" jsonb NOT NULL,
	"count" integer NOT NULL,
	"complete" boolean DEFAULT true NOT NULL,
	"note" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"ig_comment_id" text NOT NULL,
	"username" text,
	"text" text,
	"like_count" integer,
	"commented_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_insights" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"checkpoint" text NOT NULL,
	"reach" integer,
	"views" integer,
	"saves" integer,
	"shares" integer,
	"likes" integer,
	"comments" integer,
	"total_interactions" integer,
	"unavailable" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "source" text DEFAULT 'apify' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "ig_media_id" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "permalink" text;--> statement-breakpoint
ALTER TABLE "follower_snapshots" ADD CONSTRAINT "follower_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_insights" ADD CONSTRAINT "post_insights_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follower_daily_captured_idx" ON "follower_daily" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "follower_snapshots_account_idx" ON "follower_snapshots" USING btree ("account_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "post_comments_ig_id_uq" ON "post_comments" USING btree ("ig_comment_id");--> statement-breakpoint
CREATE INDEX "post_comments_post_idx" ON "post_comments" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_comments_username_idx" ON "post_comments" USING btree ("username","commented_at");--> statement-breakpoint
CREATE UNIQUE INDEX "post_insights_post_checkpoint_uq" ON "post_insights" USING btree ("post_id","checkpoint");--> statement-breakpoint
CREATE INDEX "post_insights_captured_idx" ON "post_insights" USING btree ("captured_at");