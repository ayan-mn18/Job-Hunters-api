CREATE TABLE "company_boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ats" text NOT NULL,
	"token" text NOT NULL,
	"company" text NOT NULL,
	"source" text DEFAULT 'seed' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_job_count" integer,
	"consecutive_failures" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_reranks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"description_hash" text NOT NULL,
	"persona_version" text NOT NULL,
	"fit" smallint NOT NULL,
	"rationale" text NOT NULL,
	"why_not" text,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"connector_id" text NOT NULL,
	"query" text NOT NULL,
	"market" text,
	"result_count" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_queries" ADD CONSTRAINT "search_queries_run_id_hunt_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."hunt_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_boards_ats_token_idx" ON "company_boards" USING btree ("ats","token");--> statement-breakpoint
CREATE INDEX "company_boards_active_idx" ON "company_boards" USING btree ("is_active","ats");--> statement-breakpoint
CREATE UNIQUE INDEX "job_reranks_hash_persona_idx" ON "job_reranks" USING btree ("description_hash","persona_version");--> statement-breakpoint
CREATE INDEX "search_queries_run_idx" ON "search_queries" USING btree ("run_id","connector_id");