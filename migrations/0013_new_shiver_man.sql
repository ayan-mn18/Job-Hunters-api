CREATE TABLE "account_health" (
	"user_id" uuid NOT NULL,
	"portal_id" text NOT NULL,
	"invites_7d" smallint DEFAULT 0 NOT NULL,
	"invites_today" smallint DEFAULT 0 NOT NULL,
	"accepted_7d" smallint DEFAULT 0 NOT NULL,
	"challenges_30d" smallint DEFAULT 0 NOT NULL,
	"paused_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_health_user_id_portal_id_pk" PRIMARY KEY("user_id","portal_id")
);
--> statement-breakpoint
CREATE TABLE "outreach_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"based_on" text,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_url" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"degree" smallint DEFAULT 3 NOT NULL,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" smallint DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'identified' NOT NULL,
	"invited_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"asked_at" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company" text NOT NULL,
	"target_role" text,
	"job_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_health" ADD CONSTRAINT "account_health_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_prospect_id_outreach_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."outreach_prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_prospects" ADD CONSTRAINT "outreach_prospects_target_id_outreach_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."outreach_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_prospects" ADD CONSTRAINT "outreach_prospects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD CONSTRAINT "outreach_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD CONSTRAINT "outreach_targets_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outreach_messages_prospect_idx" ON "outreach_messages" USING btree ("prospect_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_prospects_target_profile_idx" ON "outreach_prospects" USING btree ("target_id","profile_url");--> statement-breakpoint
CREATE INDEX "outreach_prospects_state_idx" ON "outreach_prospects" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "outreach_targets_user_idx" ON "outreach_targets" USING btree ("user_id","status");