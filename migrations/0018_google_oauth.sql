ALTER TABLE "users" ADD COLUMN "google_subject" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_subject_idx" ON "users" USING btree ("google_subject");