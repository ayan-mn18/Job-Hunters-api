CREATE TABLE "model_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"duration_ms" integer,
	"ok" boolean DEFAULT true NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_schedules" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"run_hour_local" smallint DEFAULT 7 NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"discover_enabled" boolean DEFAULT true NOT NULL,
	"inbox_enabled" boolean DEFAULT false NOT NULL,
	"referral_enabled" boolean DEFAULT false NOT NULL,
	"outreach_enabled" boolean DEFAULT false NOT NULL,
	"last_discover_at" timestamp with time zone,
	"last_inbox_at" timestamp with time zone,
	"last_referral_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_schedules" ADD CONSTRAINT "user_schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_usage_user_created_idx" ON "model_usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "model_usage_purpose_idx" ON "model_usage" USING btree ("purpose","created_at");