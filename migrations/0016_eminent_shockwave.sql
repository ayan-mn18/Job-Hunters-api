ALTER TABLE "apply_attempts" ADD COLUMN "live_url" text;--> statement-breakpoint
ALTER TABLE "apply_attempts" ADD COLUMN "browser_session_id" text;--> statement-breakpoint
ALTER TABLE "portal_accounts" ADD COLUMN "browser_profile_id" text;