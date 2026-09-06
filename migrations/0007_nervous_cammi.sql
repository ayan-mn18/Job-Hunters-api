CREATE TABLE "linkedin_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"external_conversation_id" text NOT NULL,
	"thread_url" text NOT NULL,
	"title" text NOT NULL,
	"scraped_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linkedin_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"external_message_id" text NOT NULL,
	"body" text NOT NULL,
	"sender_name" text NOT NULL,
	"sender_profile_url" text,
	"sent_at" timestamp with time zone NOT NULL,
	"timestamp_raw" text NOT NULL,
	"outbound" boolean DEFAULT false NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linkedin_conversations" ADD CONSTRAINT "linkedin_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_messages" ADD CONSTRAINT "linkedin_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_messages" ADD CONSTRAINT "linkedin_messages_conversation_id_linkedin_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."linkedin_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_conversations_user_external_idx" ON "linkedin_conversations" USING btree ("user_id","external_conversation_id");--> statement-breakpoint
CREATE INDEX "linkedin_conversations_user_scraped_idx" ON "linkedin_conversations" USING btree ("user_id","scraped_at");--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_messages_user_external_idx" ON "linkedin_messages" USING btree ("user_id","external_message_id");--> statement-breakpoint
CREATE INDEX "linkedin_messages_user_sent_idx" ON "linkedin_messages" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE INDEX "linkedin_messages_conversation_idx" ON "linkedin_messages" USING btree ("conversation_id","sent_at");