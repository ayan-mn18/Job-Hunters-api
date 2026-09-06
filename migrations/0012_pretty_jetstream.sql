CREATE TABLE "attempt_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"host" text NOT NULL,
	"field_signature" text NOT NULL,
	"label" text NOT NULL,
	"maps_to" text,
	"value" text,
	"confirmed" boolean DEFAULT false NOT NULL,
	"times_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_attempt_id_apply_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."apply_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_answers" ADD CONSTRAINT "field_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempt_events_attempt_idx" ON "attempt_events" USING btree ("attempt_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "field_answers_scope_idx" ON "field_answers" USING btree ("user_id","host","field_signature");--> statement-breakpoint
CREATE INDEX "field_answers_host_idx" ON "field_answers" USING btree ("host","field_signature");