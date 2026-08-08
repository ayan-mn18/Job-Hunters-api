ALTER TYPE "public"."hunt_run_job_status" ADD VALUE 'role_mismatch' BEFORE 'approved';--> statement-breakpoint
ALTER TYPE "public"."hunt_run_job_status" ADD VALUE 'seniority_mismatch' BEFORE 'approved';--> statement-breakpoint
ALTER TYPE "public"."hunt_run_job_status" ADD VALUE 'insufficient_skills' BEFORE 'approved';--> statement-breakpoint
ALTER TYPE "public"."hunt_run_job_status" ADD VALUE 'location_mismatch' BEFORE 'approved';