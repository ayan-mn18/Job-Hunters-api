ALTER TABLE "jobs" ADD COLUMN "employment_type" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "description_html" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "experience_min" smallint;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "experience_max" smallint;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "experience_text" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "salary_min" numeric;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "salary_max" numeric;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "salary_currency" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "salary_period" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "salary_text" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "responsibilities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "extraction_meta" jsonb;--> statement-breakpoint
CREATE INDEX "hunt_run_jobs_run_score_idx" ON "hunt_run_jobs" USING btree ("run_id","score" DESC NULLS LAST,"discovered_at" DESC NULLS LAST);