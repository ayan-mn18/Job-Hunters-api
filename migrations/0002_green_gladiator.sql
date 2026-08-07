CREATE TYPE "public"."hunt_run_job_status" AS ENUM('scraped', 'eligible', 'below_threshold', 'deal_breaker', 'approved', 'rejected', 'queued', 'tailored', 'applying', 'applied', 'needs_review', 'failed', 'closed');--> statement-breakpoint
CREATE TABLE "hunt_run_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"source_portal" text NOT NULL,
	"status" "hunt_run_job_status" DEFAULT 'scraped' NOT NULL,
	"score" smallint,
	"score_breakdown" jsonb,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hunt_run_jobs" ADD CONSTRAINT "hunt_run_jobs_run_id_hunt_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."hunt_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_run_jobs" ADD CONSTRAINT "hunt_run_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_run_jobs" ADD CONSTRAINT "hunt_run_jobs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hunt_run_jobs_run_job_idx" ON "hunt_run_jobs" USING btree ("run_id","job_id");--> statement-breakpoint
CREATE INDEX "hunt_run_jobs_user_status_idx" ON "hunt_run_jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "hunt_run_jobs_run_portal_idx" ON "hunt_run_jobs" USING btree ("run_id","source_portal");