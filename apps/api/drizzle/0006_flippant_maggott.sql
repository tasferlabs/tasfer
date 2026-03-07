ALTER TABLE "pages" ADD COLUMN "scheduledAt" bigint;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "duration" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "allDay" boolean;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "recurrenceId" varchar(30);--> statement-breakpoint
CREATE INDEX "pages_scheduledAt_idx" ON "pages" USING btree ("scheduledAt");