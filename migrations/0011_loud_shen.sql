CREATE TABLE "intake_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"asked" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"questions_asked" smallint DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persona_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"value" jsonb NOT NULL,
	"confidence" numeric(4, 3) DEFAULT '0' NOT NULL,
	"source" text DEFAULT 'default' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preference_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"features" jsonb NOT NULL,
	"label" smallint NOT NULL,
	"job_id" uuid,
	"compared_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intake_sessions" ADD CONSTRAINT "intake_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_slots" ADD CONSTRAINT "persona_slots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_events" ADD CONSTRAINT "preference_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_events" ADD CONSTRAINT "preference_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_events" ADD CONSTRAINT "preference_events_compared_job_id_jobs_id_fk" FOREIGN KEY ("compared_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_sessions_user_idx" ON "intake_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "persona_slots_user_slot_idx" ON "persona_slots" USING btree ("user_id","slot");--> statement-breakpoint
CREATE INDEX "preference_events_user_idx" ON "preference_events" USING btree ("user_id","created_at");