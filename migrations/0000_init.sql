CREATE TYPE "public"."activity_kind" AS ENUM('application_submitted', 'application_status_changed', 'resume_tailored', 'resume_uploaded', 'jobs_scraped', 'referral_received', 'referral_handled', 'hunt_started', 'hunt_stopped', 'portal_connected', 'portal_disconnected', 'account_created', 'onboarding_completed');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('queued', 'applied', 'viewed', 'interview', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."hunt_run_status" AS ENUM('queued', 'running', 'stopped', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."referral_source" AS ENUM('linkedin', 'email');--> statement-breakpoint
CREATE TYPE "public"."resume_kind" AS ENUM('base', 'variant');--> statement-breakpoint
CREATE TYPE "public"."resume_parse_status" AS ENUM('pending', 'parsing', 'parsed', 'failed');--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "activity_kind" NOT NULL,
	"emoji" text DEFAULT '🐾' NOT NULL,
	"text" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"from_status" "application_status",
	"to_status" "application_status" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"company" text NOT NULL,
	"logo" text DEFAULT '🏢' NOT NULL,
	"location" text,
	"salary" text,
	"job_url" text,
	"job_description" text,
	"external_job_id" text,
	"portal_id" text,
	"portal_name" text,
	"match_score" smallint,
	"status" "application_status" DEFAULT 'queued' NOT NULL,
	"resume_variant_id" uuid,
	"resume_variant_name" text,
	"hunt_run_id" uuid,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"viewed_at" timestamp with time zone,
	"interview_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text DEFAULT '💼' NOT NULL,
	"role" text NOT NULL,
	"company" text NOT NULL,
	"started_on" date,
	"ended_on" date,
	"is_current" boolean DEFAULT false NOT NULL,
	"period_label" text,
	"blurb" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hunt_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "hunt_run_status" DEFAULT 'queued' NOT NULL,
	"stop_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"target_applications" integer DEFAULT 0 NOT NULL,
	"jobs_scraped" integer DEFAULT 0 NOT NULL,
	"jobs_scored" integer DEFAULT 0 NOT NULL,
	"applications_submitted" integer DEFAULT 0 NOT NULL,
	"progress" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hunt_specs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"dream_companies" text[] DEFAULT '{}'::text[] NOT NULL,
	"locations" text[] DEFAULT '{}'::text[] NOT NULL,
	"deal_breakers" text[] DEFAULT '{}'::text[] NOT NULL,
	"min_match_score" smallint DEFAULT 70 NOT NULL,
	"daily_target" smallint DEFAULT 50 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kits" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"full_name" text,
	"pronouns" text,
	"email" text,
	"phone" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text,
	"linkedin_url" text,
	"github_url" text,
	"portfolio_url" text,
	"headline" text,
	"notice_period" text,
	"total_experience" text,
	"current_ctc" text,
	"expected_ctc" text,
	"work_authorization" text,
	"willing_to_relocate" text,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portals" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"emoji" text NOT NULL,
	"website_url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"requester_name" text NOT NULL,
	"requester_headline" text,
	"requester_avatar" text DEFAULT '🙂' NOT NULL,
	"requester_email" text,
	"requester_profile_url" text,
	"source" "referral_source" NOT NULL,
	"external_message_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"target_role" text,
	"job_requisition_id" text,
	"job_description" text,
	"resume_name" text,
	"resume_storage_path" text,
	"resume_url" text,
	"note" text,
	"match_score" smallint,
	"draft" text,
	"draft_generated_at" timestamp with time zone,
	"draft_model" text,
	"handled" boolean DEFAULT false NOT NULL,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_token_id" uuid,
	"user_agent" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "resume_kind" DEFAULT 'base' NOT NULL,
	"file_name" text NOT NULL,
	"storage_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"is_base" boolean DEFAULT false NOT NULL,
	"parse_status" "resume_parse_status" DEFAULT 'pending' NOT NULL,
	"parsed_at" timestamp with time zone,
	"parse_error" text,
	"parsed_profile" jsonb,
	"parsed_skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"parsed_titles" text[] DEFAULT '{}'::text[] NOT NULL,
	"parsed_years_experience" smallint,
	"derived_from_resume_id" uuid,
	"tailored_for_job_title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_portals" (
	"user_id" uuid NOT NULL,
	"portal_id" text NOT NULL,
	"connected" boolean DEFAULT false NOT NULL,
	"jobs_found" integer DEFAULT 0 NOT NULL,
	"connected_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_portals_user_id_portal_id_pk" PRIMARY KEY("user_id","portal_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"avatar" text DEFAULT '🧑‍🚀' NOT NULL,
	"onboarded" boolean DEFAULT false NOT NULL,
	"onboarded_at" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_portal_id_portals_id_fk" FOREIGN KEY ("portal_id") REFERENCES "public"."portals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_resume_variant_id_resumes_id_fk" FOREIGN KEY ("resume_variant_id") REFERENCES "public"."resumes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_hunt_run_id_hunt_runs_id_fk" FOREIGN KEY ("hunt_run_id") REFERENCES "public"."hunt_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_runs" ADD CONSTRAINT "hunt_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_specs" ADD CONSTRAINT "hunt_specs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kits" ADD CONSTRAINT "kits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_submissions" ADD CONSTRAINT "onboarding_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_portals" ADD CONSTRAINT "user_portals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_portals" ADD CONSTRAINT "user_portals_portal_id_portals_id_fk" FOREIGN KEY ("portal_id") REFERENCES "public"."portals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_user_idx" ON "activity_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "application_events_app_idx" ON "application_events" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "applications_user_status_idx" ON "applications" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "applications_user_applied_idx" ON "applications" USING btree ("user_id","applied_at");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_user_portal_job_idx" ON "applications" USING btree ("user_id","portal_id","external_job_id") WHERE "applications"."external_job_id" is not null;--> statement-breakpoint
CREATE INDEX "employments_user_idx" ON "employments" USING btree ("user_id","sort_order");--> statement-breakpoint
CREATE INDEX "hunt_runs_user_idx" ON "hunt_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "onboarding_submissions_user_idx" ON "onboarding_submissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "referrals_user_received_idx" ON "referrals" USING btree ("user_id","received_at");--> statement-breakpoint
CREATE INDEX "referrals_user_handled_idx" ON "referrals" USING btree ("user_id","handled");--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_external_message_idx" ON "referrals" USING btree ("user_id","source","external_message_id") WHERE "referrals"."external_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_idx" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "resumes_user_idx" ON "resumes" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "resumes_one_base_per_user_idx" ON "resumes" USING btree ("user_id") WHERE "resumes"."is_base" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));