CREATE TYPE "public"."playground_run_status" AS ENUM('queued', 'launching', 'searching', 'shortlisted', 'applying', 'blocked', 'submitted', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."playground_speaker" AS ENUM('huntly', 'agent', 'llm', 'user', 'system');--> statement-breakpoint
CREATE TABLE "playground_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"speaker" "playground_speaker" NOT NULL,
	"body" text NOT NULL,
	"kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playground_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"status" "playground_run_status" DEFAULT 'queued' NOT NULL,
	"skill_id" text,
	"live_url" text,
	"browser_session_id" text,
	"shortlist" jsonb,
	"chosen_job_url" text,
	"chosen_job_title" text,
	"chosen_job_company" text,
	"application_id" uuid,
	"filled_fields" jsonb,
	"blocked_fields" jsonb,
	"pending_question" text,
	"dry_run" boolean DEFAULT true NOT NULL,
	"email_sent_at" timestamp with time zone,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playground_messages" ADD CONSTRAINT "playground_messages_run_id_playground_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."playground_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playground_runs" ADD CONSTRAINT "playground_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playground_runs" ADD CONSTRAINT "playground_runs_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playground_messages_run_idx" ON "playground_messages" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "playground_runs_user_idx" ON "playground_runs" USING btree ("user_id","created_at");