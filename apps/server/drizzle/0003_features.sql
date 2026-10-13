CREATE TABLE "channel_reads" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"channel_id" uuid,
	"thread_root_id" uuid,
	"message_id" uuid,
	"created_by_run_id" uuid,
	"platform" text DEFAULT 'x' NOT NULL,
	"kind" text DEFAULT 'post' NOT NULL,
	"parts" jsonb NOT NULL,
	"reply_to_url" text,
	"media_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"published_url" text,
	"published_at" timestamp with time zone,
	"owner_feedback" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"bot_id" uuid,
	"channel_id" uuid,
	"thread_root_id" uuid,
	"task_id" uuid,
	"run_at" timestamp with time zone NOT NULL,
	"instruction" text NOT NULL,
	"created_by" text NOT NULL,
	"created_by_run_id" uuid,
	"chain_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_message_id" uuid,
	"fired_at" timestamp with time zone,
	"run_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner_presence" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"channel_id" uuid,
	"visible" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_status" (
	"key" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"url" text NOT NULL,
	"kind" text DEFAULT 'page' NOT NULL,
	"selector" text,
	"render" text DEFAULT 'http' NOT NULL,
	"interval_min" integer DEFAULT 60 NOT NULL,
	"instruction" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"proposed" boolean DEFAULT false NOT NULL,
	"last_hash" text,
	"last_snapshot" text,
	"last_diff" text,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "completion_push" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "proposed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "completion_push" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "silent_if_nothing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "run_model_usage" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "run_model_usage" ADD COLUMN "routine_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assignee" text DEFAULT 'bot' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_reads" ADD CONSTRAINT "channel_reads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drafts_status_idx" ON "drafts" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "drafts_bot_created_idx" ON "drafts" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "followups_due_idx" ON "followups" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "followups_bot_status_idx" ON "followups" USING btree ("bot_id","status");--> statement-breakpoint
CREATE INDEX "followups_task_idx" ON "followups" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "owner_presence_channel_idx" ON "owner_presence" USING btree ("channel_id","updated_at");--> statement-breakpoint
CREATE INDEX "watches_due_idx" ON "watches" USING btree ("enabled","next_check_at");--> statement-breakpoint
CREATE INDEX "watches_bot_idx" ON "watches" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "run_model_usage_routine_idx" ON "run_model_usage" USING btree ("routine_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_status_idx" ON "tasks" USING btree ("assignee","status");--> statement-breakpoint
-- Data: routines a bot proposed before `proposed` existed (created disabled, never run) stay flagged as proposals.
UPDATE "routines" SET "proposed" = true WHERE "enabled" = false AND "last_run_at" IS NULL;--> statement-breakpoint
-- Data: usage already recorded for a run gets its origin back from the run; one-shot rows (no run) stay « non classé ».
UPDATE "run_model_usage" AS u
SET "purpose" = r."trigger",
    "routine_id" = (SELECT ro."id" FROM "routines" AS ro WHERE ro."id"::text = r."payload"->>'routineId')
FROM "runs" AS r
WHERE u."run_id" = r."id" AND u."purpose" IS NULL;
--> statement-breakpoint
-- Data: an installation that already has bots does not need the first-run guide (/bienvenue).
INSERT INTO "settings" ("key", "value")
SELECT 'app', jsonb_build_object('onboardingDoneAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
WHERE EXISTS (SELECT 1 FROM "bots")
ON CONFLICT ("key") DO UPDATE SET "value" = "settings"."value" || EXCLUDED."value", "updated_at" = now();
