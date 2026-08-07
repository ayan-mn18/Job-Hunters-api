CREATE TYPE "public"."apply_attempt_status" AS ENUM('pending', 'submitting', 'submitted', 'needs_review', 'unknown', 'failed');--> statement-breakpoint
CREATE TYPE "public"."hunt_candidate_status" AS ENUM('discovered', 'approved', 'rejected', 'tailored', 'queued', 'applying', 'applied', 'needs_review', 'failed');--> statement-breakpoint
CREATE TYPE "public"."portal_account_status" AS ENUM('absent', 'provisioning', 'pending_verification', 'ready', 'blocked', 'failed');--> statement-breakpoint
ALTER TYPE "public"."application_status" ADD VALUE 'needs_review';--> statement-breakpoint
ALTER TYPE "public"."application_status" ADD VALUE 'failed';--> statement-breakpoint
ALTER TYPE "public"."application_status" ADD VALUE 'closed';--> statement-breakpoint
ALTER TYPE "public"."hunt_run_status" ADD VALUE 'awaiting_approval' BEFORE 'stopped';--> statement-breakpoint
ALTER TYPE "public"."hunt_run_status" ADD VALUE 'applying' BEFORE 'stopped';--> statement-breakpoint
ALTER TYPE "public"."hunt_run_status" ADD VALUE 'paused' BEFORE 'stopped';--> statement-breakpoint
CREATE TABLE "apply_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"portal_id" text NOT NULL,
	"status" "apply_attempt_status" DEFAULT 'pending' NOT NULL,
	"external_application_id" text,
	"submitted_fields" jsonb,
	"unresolved_fields" jsonb,
	"evidence_storage_path" text,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hunt_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"source_portal" text NOT NULL,
	"score" smallint NOT NULL,
	"score_breakdown" jsonb NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "hunt_candidate_status" DEFAULT 'discovered' NOT NULL,
	"resume_variant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"portal_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_url" text NOT NULL,
	"apply_url" text,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"locations" jsonb NOT NULL,
	"remote_mode" text DEFAULT 'unknown' NOT NULL,
	"description_text" text,
	"description_hash" text,
	"canonical_url" text NOT NULL,
	"apply_url" text,
	"posted_at" timestamp with time zone NOT NULL,
	"posted_at_precision" text NOT NULL,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"portal_id" text NOT NULL,
	"email" text NOT NULL,
	"encrypted_credentials" text,
	"status" "portal_account_status" DEFAULT 'absent' NOT NULL,
	"external_user_id" text,
	"action_required" text,
	"last_verified_at" timestamp with time zone,
	"profile_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resume_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"base_resume_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"storage_path" text NOT NULL,
	"plan" jsonb NOT NULL,
	"changed" boolean DEFAULT false NOT NULL,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hunt_specs" ALTER COLUMN "daily_target" SET DEFAULT 100;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "hunt_runs" ADD COLUMN "candidates_approved" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hunt_runs" ADD COLUMN "applications_needs_review" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hunt_runs" ADD COLUMN "approval_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "hunt_runs" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kits" ADD COLUMN "photo_storage_path" text;--> statement-breakpoint
ALTER TABLE "kits" ADD COLUMN "photo_file_name" text;--> statement-breakpoint
ALTER TABLE "kits" ADD COLUMN "photo_mime_type" text;--> statement-breakpoint
ALTER TABLE "resumes" ADD COLUMN "structured_document" jsonb;--> statement-breakpoint
ALTER TABLE "resumes" ADD COLUMN "structured_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "resumes" ADD COLUMN "structured_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "apply_attempts" ADD CONSTRAINT "apply_attempts_candidate_id_hunt_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."hunt_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apply_attempts" ADD CONSTRAINT "apply_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_candidates" ADD CONSTRAINT "hunt_candidates_run_id_hunt_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."hunt_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_candidates" ADD CONSTRAINT "hunt_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_candidates" ADD CONSTRAINT "hunt_candidates_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sources" ADD CONSTRAINT "job_sources_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_accounts" ADD CONSTRAINT "portal_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_variants" ADD CONSTRAINT "resume_variants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_variants" ADD CONSTRAINT "resume_variants_candidate_id_hunt_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."hunt_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_variants" ADD CONSTRAINT "resume_variants_base_resume_id_resumes_id_fk" FOREIGN KEY ("base_resume_id") REFERENCES "public"."resumes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apply_attempts_candidate_idx" ON "apply_attempts" USING btree ("candidate_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hunt_candidates_run_job_idx" ON "hunt_candidates" USING btree ("run_id","job_id");--> statement-breakpoint
CREATE INDEX "hunt_candidates_user_status_idx" ON "hunt_candidates" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "job_sources_portal_source_idx" ON "job_sources" USING btree ("portal_id","source_id");--> statement-breakpoint
CREATE INDEX "job_sources_job_idx" ON "job_sources" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_fingerprint_idx" ON "jobs" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "jobs_posted_idx" ON "jobs" USING btree ("posted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_accounts_user_portal_idx" ON "portal_accounts" USING btree ("user_id","portal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resume_variants_candidate_idx" ON "resume_variants" USING btree ("candidate_id");--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "applications_user_job_idx" ON "applications" USING btree ("user_id","job_id") WHERE "applications"."job_id" is not null;