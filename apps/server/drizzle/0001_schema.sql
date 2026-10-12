CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"thread_key" text NOT NULL,
	"sdk_session_id" text,
	"generation" integer DEFAULT 1 NOT NULL,
	"approx_tokens" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"last_seen_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"bot_id" uuid NOT NULL,
	"channel_id" uuid,
	"thread_root_id" uuid,
	"category" text NOT NULL,
	"tool" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"screenshot_png" text,
	"urgent" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"comment" text,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"event" text NOT NULL,
	"run_id" uuid,
	"tool" text,
	"detail" jsonb,
	"outcome" text,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"stage" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"avatar" text DEFAULT '🐜' NOT NULL,
	"role" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"heartbeat_enabled" boolean DEFAULT true NOT NULL,
	"heartbeat_interval_min" integer DEFAULT 180 NOT NULL,
	"quiet_hours" jsonb,
	"api_daily_cap_usd" double precision,
	"paused" boolean DEFAULT false NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bots_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "budget_alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"period_key" text NOT NULL,
	"threshold" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_members" (
	"channel_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	CONSTRAINT "channel_members_channel_id_bot_id_pk" PRIMARY KEY("channel_id","bot_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"topic" text DEFAULT '' NOT NULL,
	"dm_bot_id" uuid,
	"last_message_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compute_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"sub_configured" boolean DEFAULT false NOT NULL,
	"api_configured" boolean DEFAULT false NOT NULL,
	"sub_limited_until" timestamp with time zone,
	"sub_five_hour_util" double precision,
	"sub_five_hour_resets_at" timestamp with time zone,
	"sub_seven_day_util" double precision,
	"sub_seven_day_resets_at" timestamp with time zone,
	"sub_last_status" text,
	"sub_auth_failed" boolean DEFAULT false NOT NULL,
	"sub_last_event_at" timestamp with time zone,
	"api_auth_failed" boolean DEFAULT false NOT NULL,
	"all_paused_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "computer_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"holder" text DEFAULT 'agents' NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"active_bot_id" uuid,
	"last_action" text,
	"url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" uuid NOT NULL,
	"from_bot_id" uuid NOT NULL,
	"to_bot_id" uuid NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lane" text,
	"dedupe_key" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ip" text NOT NULL,
	"kind" text NOT NULL,
	"success" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"bot_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"importance" integer DEFAULT 3 NOT NULL,
	"author_kind" text NOT NULL,
	"author_bot_id" uuid,
	"source_message_id" uuid,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('french', ant_unaccent(coalesce(title, '') || ' ' || coalesce(content, '')))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"thread_root_id" uuid,
	"author_kind" text NOT NULL,
	"bot_id" uuid,
	"content" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'done' NOT NULL,
	"run_id" uuid,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('french', ant_unaccent(coalesce(content, '')))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nudges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'delivered' NOT NULL,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "owner" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"recovery_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"webauthn_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ok_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"source_text" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"instruction" text NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_model_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid,
	"bot_id" uuid,
	"day" text NOT NULL,
	"month" text NOT NULL,
	"model" text NOT NULL,
	"compute_source" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"channel_id" uuid,
	"thread_root_id" uuid,
	"thread_key" text NOT NULL,
	"trigger" text NOT NULL,
	"priority" text NOT NULL,
	"origin" text NOT NULL,
	"chain_id" uuid NOT NULL,
	"hop" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"compute_source" text,
	"compute_reason" text,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"prompt" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activity" text,
	"response_message_id" uuid,
	"sdk_session_id" text,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"limit_type" text,
	"utilization" double precision,
	"resets_at" timestamp with time zone,
	"raw" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"title" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone,
	"source_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"device_type" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "webauthn_credentials_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_dm_bot_id_bots_id_fk" FOREIGN KEY ("dm_bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_from_bot_id_bots_id_fk" FOREIGN KEY ("from_bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_to_bot_id_bots_id_fk" FOREIGN KEY ("to_bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_author_bot_id_bots_id_fk" FOREIGN KEY ("author_bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_model_usage" ADD CONSTRAINT "run_model_usage_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_model_usage" ADD CONSTRAINT "run_model_usage_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_active_uidx" ON "agent_sessions" USING btree ("bot_id","thread_key") WHERE "agent_sessions"."active";--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_event_idx" ON "audit_log" USING btree ("event","at");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_alerts_uidx" ON "budget_alerts" USING btree ("scope","period_key","threshold");--> statement-breakpoint
CREATE INDEX "handoffs_chain_idx" ON "handoffs" USING btree ("chain_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_pending_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uidx" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_lane_idx" ON "jobs" USING btree ("lane","status");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_at_idx" ON "login_attempts" USING btree ("ip","at");--> statement-breakpoint
CREATE INDEX "memory_scope_idx" ON "memory_items" USING btree ("scope","bot_id");--> statement-breakpoint
CREATE INDEX "memory_search_idx" ON "memory_items" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "messages_channel_created_idx" ON "messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_root_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "messages" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "nudges_bot_created_idx" ON "nudges" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "nudges_fingerprint_idx" ON "nudges" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "run_model_usage_day_idx" ON "run_model_usage" USING btree ("day");--> statement-breakpoint
CREATE INDEX "run_model_usage_month_idx" ON "run_model_usage" USING btree ("month","compute_source");--> statement-breakpoint
CREATE INDEX "runs_bot_created_idx" ON "runs" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_chain_idx" ON "runs" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX "tasks_bot_status_idx" ON "tasks" USING btree ("bot_id","status");